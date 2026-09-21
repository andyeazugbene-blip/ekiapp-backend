import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    dispute: { findUnique: vi.fn(), update: vi.fn() },
    order: { findUnique: vi.fn(), update: vi.fn() },
    user: { update: vi.fn() },
    vendor: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: any) => fn({
      dispute: { update: vi.fn() },
      order: { update: vi.fn() },
      user: { update: vi.fn() },
      paystackTransaction: { update: vi.fn() },
    })),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { refunds: { create: vi.fn() } },
}));

vi.mock("../lib/paystack", () => ({
  paystack: { refundTransaction: vi.fn(), isConfigured: vi.fn(() => true) },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../shared/utils/wallet-release", () => ({
  releaseVendorEarnings: vi.fn().mockResolvedValue({ released: true, amount: 1000 }),
}));

/**
 * REG-01 fix: resolveDispute()'s vendor-favour branch does
 * `await import("./escrow.service.js")` (dispute.service.ts:255) — a
 * deliberate lazy import, not a circular-dependency workaround (confirmed:
 * escrow.service.ts does not import dispute.service.ts anywhere). Left
 * unmocked, that dynamic import pulls in escrow.service.ts's entire real
 * dependency graph for the first time inside this test — including
 * `lib/sms.ts` (Africa's Talking), `lib/email-queue.ts` (BullMQ/ioredis),
 * and `lib/push-notifications.ts` (Expo) — none of which this test needs
 * or the rest of this file mocks. That cold, heavy `require()` graph is
 * what exceeded the test's timeout, not a real hang: in production these
 * modules are already resident in the module cache from server startup, so
 * the same dynamic import there always resolves instantly. Mocking
 * escrowService here (the same way every other dispute.service.ts
 * dependency above is already mocked) is the correct, minimal fix — no
 * production code changes needed.
 */
vi.mock("../modules/paystack/escrow.service", () => ({
  escrowService: { initiateVendorPayout: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { paystack } from "../lib/paystack";
import { disputeService } from "../modules/paystack/dispute.service";

const m = vi.mocked(prisma, true);
const refundTransaction = vi.mocked(paystack.refundTransaction);
const stripeRefundCreate = vi.mocked(stripe.refunds.create);

const openDispute = (overrides: Partial<any> = {}) => ({
  id: "dispute-1",
  status: "OPEN",
  buyerId: "buyer-1",
  orderId: "order-1",
  order: {
    id: "order-1",
    buyerId: "buyer-1",
    vendorId: "vendor-1",
    totalAmount: 5000,
    vendorEarnings: 4000,
    currency: "gbp",
    orderNumber: "ORD-1",
  },
  ...overrides,
});

/** The independent order row executeOrderRefund() fetches for itself
 * (dispute.service.ts no longer selects payment/paystackTransaction on its
 * own dispute.order include — Defect E moved all provider-specific refund
 * logic into the shared executeOrderRefund(), which does its own fetch). */
const paystackPaidOrderRow = (overrides: Partial<any> = {}) => ({
  id: "order-1",
  status: "DISPUTED",
  totalAmount: 5000,
  currency: "gbp",
  checkoutCurrency: null,
  exchangeRate: null,
  payment: null,
  paystackTransaction: { reference: "ref_123", status: "SUCCESS", amount: 5000 },
  ...overrides,
});

const stripePaidOrderRow = (overrides: Partial<any> = {}) => ({
  id: "order-1",
  status: "DISPUTED",
  totalAmount: 5000,
  currency: "gbp",
  checkoutCurrency: null,
  exchangeRate: null,
  payment: { id: "pay-1", stripePaymentIntentId: "pi_1", status: "SUCCEEDED", amount: 5000, provider: "stripe" },
  paystackTransaction: null,
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

/**
 * Regression coverage for the dispute-resolution false-success bug: the
 * dispute/order used to be committed as RESOLVED_BUYER/REFUNDED BEFORE the
 * real refund was even attempted, with a provider failure only logged —
 * leaving a dispute that claims "refunded" with no real refund and no retry
 * path (re-resolving an already-resolved dispute 409s). Fixed by issuing the
 * refund first and only committing the terminal state on success, mirroring
 * the four-eyes approval execution-ordering fix.
 */
describe("disputeService.resolveDispute — refund-before-commit", () => {
  it("a Paystack refund failure leaves the dispute unresolved (no DB commit), not falsely RESOLVED_BUYER", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute() as never);
    m.order.findUnique.mockResolvedValue(paystackPaidOrderRow() as never);
    refundTransaction.mockRejectedValue(new Error("Paystack refund failed: card issuer declined"));

    await expect(
      disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "buyer", note: "refund the buyer" }),
    ).rejects.toThrow(/refund failed/i);

    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("a successful Paystack refund commits RESOLVED_BUYER / order REFUNDED", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute() as never);
    m.order.findUnique.mockResolvedValue(paystackPaidOrderRow() as never);
    refundTransaction.mockResolvedValue(undefined as never);

    const result = await disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "buyer", note: "refund the buyer" });

    expect(result.status).toBe("RESOLVED_BUYER");
    expect(refundTransaction).toHaveBeenCalledWith("ref_123", undefined);
    // Once inside executeOrderRefund() (order status + PaystackTransaction),
    // once again for the dispute's own resolution commit (dispute status,
    // order status, trust-score adjustment) — two distinct, sequential
    // transactions is the correct "real side effect first, then commit"
    // shape this suite documents above, not a regression.
    expect(m.$transaction).toHaveBeenCalledTimes(2);
  });

  it("refuses to resolve in the buyer's favour when the order has no payment of any kind to refund, rather than silently marking it refunded", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute() as never);
    m.order.findUnique.mockResolvedValue(paystackPaidOrderRow({ payment: null, paystackTransaction: null }) as never);

    await expect(
      disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "buyer", note: "refund the buyer" }),
    ).rejects.toThrow(/no stripe payment found/i);

    expect(refundTransaction).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("a vendor-favour resolution never calls any refund provider, and does initiate the vendor payout", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute() as never);

    const result = await disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "vendor", note: "release to vendor" });

    expect(result.status).toBe("RESOLVED_VENDOR");
    expect(refundTransaction).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    const { escrowService } = await import("../modules/paystack/escrow.service");
    expect(escrowService.initiateVendorPayout).toHaveBeenCalledWith("order-1");
  });

  it("rejects re-resolving an already-resolved dispute", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute({ status: "RESOLVED_BUYER" }) as never);

    await expect(
      disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "vendor", note: "too late" }),
    ).rejects.toThrow(/already resolved/i);
  });
});

/**
 * Acceptance audit fix (Defect E) — resolveDispute() used to call
 * paystack.refundTransaction() directly against the order's
 * PaystackTransaction reference. A Stripe-paid order has no such reference,
 * so resolving ANY dispute in the buyer's favour was structurally
 * impossible for a Stripe order — it always hit the "no payment reference"
 * guard, regardless of how genuinely valid the dispute was. Fixed by
 * routing the refund through executeOrderRefund(), which already branches
 * on the order's real payment provider.
 */
describe("disputeService.resolveDispute — Stripe-paid orders (Defect E)", () => {
  it("resolves in the buyer's favour via a real Stripe refund — previously impossible", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute() as never);
    m.order.findUnique.mockResolvedValue(stripePaidOrderRow() as never);
    stripeRefundCreate.mockResolvedValue({ id: "re_1", amount: 5000, status: "succeeded" } as never);

    const result = await disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "buyer", note: "refund the buyer" });

    expect(result.status).toBe("RESOLVED_BUYER");
    expect(stripeRefundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1", amount: 5000 }),
      expect.any(Object),
    );
    expect(refundTransaction).not.toHaveBeenCalled();
  });

  it("a partial resolution issues a partial Stripe refund for exactly the specified amount", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute() as never);
    m.order.findUnique.mockResolvedValue(stripePaidOrderRow() as never);
    stripeRefundCreate.mockResolvedValue({ id: "re_2", amount: 1500, status: "succeeded" } as never);

    const result = await disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "partial", note: "partial refund", refundAmount: 1500 });

    expect(result.status).toBe("RESOLVED_PARTIAL");
    expect(stripeRefundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1500 }),
      expect.any(Object),
    );
  });

  it("a Stripe refund failure leaves the dispute OPEN for retry, exactly like the Paystack failure path", async () => {
    m.dispute.findUnique.mockResolvedValue(openDispute() as never);
    m.order.findUnique.mockResolvedValue(stripePaidOrderRow() as never);
    stripeRefundCreate.mockRejectedValue(new Error("card issuer declined"));

    await expect(
      disputeService.resolveDispute("dispute-1", "admin-1", { resolution: "buyer", note: "refund the buyer" }),
    ).rejects.toThrow(/refund failed/i);

    expect(m.$transaction).not.toHaveBeenCalled();
  });
});
