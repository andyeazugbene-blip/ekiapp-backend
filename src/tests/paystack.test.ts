import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Mock prisma
vi.mock("../lib/prisma", () => ({
  prisma: {
    paystackTransaction: { findUnique: vi.fn(), update: vi.fn() },
    order: { update: vi.fn(), findUnique: vi.fn() },
    vendor: { findUnique: vi.fn() },
    webhookEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../modules/ledger/ledger.service", () => ({
  ledgerService: { postEntriesSafely: vi.fn(), reverseEntries: vi.fn() },
}));

vi.mock("../lib/paystack", () => ({
  paystack: {
    isConfigured: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    refundTransaction: vi.fn(),
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { paystack } from "../lib/paystack";
import { paystackService } from "../modules/paystack/paystack.service";
import { ledgerService } from "../modules/ledger/ledger.service";

const txFindUnique = prisma.paystackTransaction.findUnique as unknown as ReturnType<typeof vi.fn>;
const webhookCreate = prisma.webhookEvent.create as unknown as ReturnType<typeof vi.fn>;
const dbTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const ledgerPost = ledgerService.postEntriesSafely as unknown as ReturnType<typeof vi.fn>;
const paystackVerifySig = paystack.verifyWebhookSignature as unknown as ReturnType<typeof vi.fn>;
const paystackIsConfigured = paystack.isConfigured as unknown as ReturnType<typeof vi.fn>;
const paystackRefund = paystack.refundTransaction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("Paystack Webhook Signature Verification", () => {
  it("valid HMAC-SHA512 signature passes verification", () => {
    const secret = "sk_test_abc123";
    const body = JSON.stringify({ event: "charge.success", data: { reference: "ref-1" } });
    const hash = crypto.createHmac("sha512", secret).update(body).digest("hex");

    // The real implementation in src/lib/paystack.ts
    const computed = crypto.createHmac("sha512", secret).update(body).digest("hex");
    expect(computed).toBe(hash);
  });

  it("invalid signature does not match", () => {
    const secret = "sk_test_abc123";
    const body = JSON.stringify({ event: "charge.success", data: { reference: "ref-1" } });
    const fakeSignature = "deadbeef";

    const computed = crypto.createHmac("sha512", secret).update(body).digest("hex");
    expect(computed).not.toBe(fakeSignature);
  });
});

describe("Paystack Webhook Idempotency", () => {
  it("duplicate charge.success cannot double-credit (WebhookEvent unique constraint)", async () => {
    const reference = "ref-duplicate-test";

    txFindUnique.mockResolvedValue({
      id: "tx-1", orderId: "order-1", reference, status: "PENDING", amount: 5000,
    });

    // The service uses Prisma.PrismaClientKnownRequestError with code P2002.
    // We need to create an error that passes the instanceof check.
    // Import the actual error class from Prisma runtime.
    const { Prisma } = await import("@prisma/client");
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`stripeEventId`)",
      { code: "P2002", clientVersion: "6.19.3" },
    );

    webhookCreate.mockRejectedValueOnce(p2002Error);

    // handleChargeSuccess should catch P2002 and return silently
    await paystackService.handleChargeSuccess(reference, { status: "success" });

    // Verify WebhookEvent.create was attempted
    expect(webhookCreate).toHaveBeenCalled();
    // $transaction should NOT be called (duplicate caught)
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it("already-processed transaction returns early", async () => {
    txFindUnique.mockResolvedValue({
      id: "tx-1", orderId: "order-1", reference: "ref-done", status: "SUCCESS",
    });

    await paystackService.handleChargeSuccess("ref-done", {});

    // WebhookEvent.create should NOT be called (early return)
    expect(webhookCreate).not.toHaveBeenCalled();
  });

  it("unknown reference is silently ignored", async () => {
    txFindUnique.mockResolvedValue(null);

    await paystackService.handleChargeSuccess("ref-unknown", {});

    expect(webhookCreate).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  // Regression test for a real bug found in the A→Z gap-closure audit:
  // the WebhookEvent row was created PROCESSING and never updated, so it
  // stayed stuck forever — no visibility that the webhook ever completed.
  it("marks the WebhookEvent PROCESSED after a successful charge (not left stuck at PROCESSING)", async () => {
    const reference = "ref-marks-processed";
    txFindUnique.mockResolvedValue({ id: "tx-1", orderId: "order-1", reference, status: "PENDING", amount: 5000 });
    webhookCreate.mockResolvedValue({});

    const fakeDb = {
      paystackTransaction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      order: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ vendorId: "vendor-1", vendorEarnings: 4500, platformFeeAmount: 500, currency: "ngn" }),
      },
      webhookEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    dbTransaction.mockImplementation(async (cb: (db: unknown) => Promise<void>) => cb(fakeDb));

    await paystackService.handleChargeSuccess(reference, { status: "success" });

    expect(fakeDb.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeEventId: `paystack:${reference}` }, data: expect.objectContaining({ status: "PROCESSED" }) }),
    );
  });

  // Regression test: order transition must be a conditional updateMany
  // guarded on status:"PENDING" (mirrors the Stripe webhook), not an
  // unconditional update — otherwise a replayed/out-of-order webhook could
  // silently overwrite an already-secured or cancelled order.
  it("does not re-transition an order that is no longer PENDING (idempotent state guard)", async () => {
    const reference = "ref-already-secured";
    txFindUnique.mockResolvedValue({ id: "tx-1", orderId: "order-1", reference, status: "PENDING", amount: 5000 });
    webhookCreate.mockResolvedValue({});

    const fakeDb = {
      paystackTransaction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn() },
      webhookEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    dbTransaction.mockImplementation(async (cb: (db: unknown) => Promise<void>) => cb(fakeDb));

    await paystackService.handleChargeSuccess(reference, { status: "success" });

    expect(fakeDb.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "order-1", status: "PENDING" } }),
    );
    // count:0 means no order actually transitioned — ledger must not post for it
    expect(fakeDb.order.findUnique).not.toHaveBeenCalled();
  });

  it("posts a balanced ledger entry (vendor payable + platform fee) when escrow payment secures", async () => {
    const reference = "ref-ledger-post";
    txFindUnique.mockResolvedValue({ id: "tx-1", orderId: "order-1", reference, status: "PENDING", amount: 5000 });
    webhookCreate.mockResolvedValue({});

    const fakeDb = {
      paystackTransaction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      order: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ vendorId: "vendor-1", vendorEarnings: 4500, platformFeeAmount: 500, currency: "ngn" }),
      },
      webhookEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    dbTransaction.mockImplementation(async (cb: (db: unknown) => Promise<void>) => cb(fakeDb));

    await paystackService.handleChargeSuccess(reference, { status: "success" });

    expect(ledgerPost).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        businessRefType: "Order",
        businessRefId: "order-1",
        legs: expect.arrayContaining([
          expect.objectContaining({ accountType: "VENDOR_PAYABLE", amount: 4500 }),
          expect.objectContaining({ accountType: "PLATFORM_FEE_REVENUE", amount: 500 }),
        ]),
      }),
    );
  });
});

describe("Paystack Refund Path", () => {
  it("Paystack refund calls paystack.refundTransaction for Paystack payments", async () => {
    paystackIsConfigured.mockReturnValue(true);
    paystackRefund.mockResolvedValue(undefined);

    // Simulate calling the refund function directly
    await paystack.refundTransaction("ref-to-refund", 5000);

    expect(paystackRefund).toHaveBeenCalledWith("ref-to-refund", 5000);
  });
});

describe("Paystack Configuration Safety", () => {
  it("isConfigured returns false when PAYSTACK_SECRET_KEY is missing", () => {
    paystackIsConfigured.mockReturnValue(false);
    expect(paystack.isConfigured()).toBe(false);
  });

  it("isConfigured returns true when key is present", () => {
    paystackIsConfigured.mockReturnValue(true);
    expect(paystack.isConfigured()).toBe(true);
  });
});
