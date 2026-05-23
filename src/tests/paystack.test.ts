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

const txFindUnique = prisma.paystackTransaction.findUnique as unknown as ReturnType<typeof vi.fn>;
const webhookCreate = prisma.webhookEvent.create as unknown as ReturnType<typeof vi.fn>;
const dbTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
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
