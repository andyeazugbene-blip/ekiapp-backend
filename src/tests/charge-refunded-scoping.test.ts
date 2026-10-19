/**
 * B4 (Handbook 14.8): charge.refunded on a multi-vendor checkout must only
 * refund / reverse / restock the orders that are actually refunded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  webhookEvent: { create: vi.fn(), update: vi.fn() },
  checkout: { findUnique: vi.fn() },
  refund: { groupBy: vi.fn() },
  order: { updateMany: vi.fn() },
  walletTransaction: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  wallet: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  product: { update: vi.fn() },
  payment: { findFirst: vi.fn() },
  communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
};

vi.mock("../lib/prisma", () => ({
  prisma: { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)), webhookEvent: { updateMany: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("../lib/stripe", () => ({ stripe: { webhooks: { constructEvent: vi.fn() } } }));
vi.mock("../config/env", () => ({ env: { stripeWebhookSecret: "whsec", stripeIdentityWebhookSecret: "whsec_i" } }));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ message: String(e) })),
}));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/ledger/ledger.service", () => ({ ledgerService: { reverseEntries: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/community-buy/campaign-payout.service", () => ({ campaignPayoutService: {} }));
vi.mock("../modules/community-buy/campaign-authorisation.service", () => ({ campaignAuthorisationService: {} }));
vi.mock("../modules/community-buy/organiser-stripe-connect.service", () => ({ organiserStripeConnectService: {} }));
vi.mock("../modules/vendors/stripe-connect.service", () => ({ stripeConnectService: {} }));

import { stripe } from "../lib/stripe";
import { logger } from "../lib/logger";
import { stripeWebhookService } from "../modules/stripe/stripe.service";

const constructEvent = vi.mocked(stripe.webhooks.constructEvent);

const checkout = {
  id: "co-1", buyerId: "buyer-1",
  orders: [
    { id: "ord-A", vendorId: "v-A", totalAmount: 6000, payment: { id: "pay-A", vendorEarningsAmount: 5000, currency: "eur" }, items: [{ productId: "p-A", quantity: 2 }] },
    { id: "ord-B", vendorId: "v-B", totalAmount: 4000, payment: { id: "pay-B", vendorEarningsAmount: 3500, currency: "eur" }, items: [{ productId: "p-B", quantity: 1 }] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  tx.webhookEvent.create.mockResolvedValue({});
  tx.webhookEvent.update.mockResolvedValue({});
  tx.checkout.findUnique.mockResolvedValue(checkout);
  tx.walletTransaction.findFirst.mockResolvedValue(null);
});

function fire(chargeOverrides: Record<string, unknown>) {
  constructEvent.mockReturnValue({
    id: "evt_ref", type: "charge.refunded",
    data: { object: { payment_intent: "pi_1", amount: 10000, amount_refunded: 0, ...chargeOverrides } },
  } as never);
  return stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });
}

describe("charge.refunded scoping", () => {
  it("a PARTIAL refund of one vendor's order does not touch the other vendors' orders", async () => {
    tx.refund.groupBy.mockResolvedValue([{ orderId: "ord-A", _sum: { amountMinor: 2000 } }]); // partial of A only
    await fire({ amount_refunded: 2000 });

    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("only the fully refunded order (per recorded refunds) is reversed and restocked", async () => {
    tx.refund.groupBy.mockResolvedValue([{ orderId: "ord-B", _sum: { amountMinor: 4000 } }]);
    await fire({ amount_refunded: 4000 });

    const refundedIds = tx.order.updateMany.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(refundedIds).toEqual(["ord-B"]);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p-B" } }));
  });

  it("a full-charge refund covers every order in the checkout", async () => {
    tx.refund.groupBy.mockResolvedValue([]);
    await fire({ amount_refunded: 10000 });

    const refundedIds = tx.order.updateMany.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id).sort();
    expect(refundedIds).toEqual(["ord-A", "ord-B"]);
  });

  it("each order is reversed exactly once: a second charge.refunded does not re-restock it", async () => {
    tx.refund.groupBy.mockResolvedValue([]);
    // the per-order reversal marker already exists (unique violation) for ord-A
    tx.webhookEvent.create
      .mockResolvedValueOnce({}) // the event claim itself
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" })) // marker for ord-A
      .mockResolvedValueOnce({}); // marker for ord-B
    await fire({ amount_refunded: 10000 });

    const refundedIds = tx.order.updateMany.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(refundedIds).toEqual(["ord-B"]);
  });
});

describe("charge.refunded — wallet reversal claws back from the right balance (19 Oct 2026 fix)", () => {
  function mockFindFirst(opts: { credit?: { amount: number; currency: string }; alreadyReleased?: boolean }) {
    tx.walletTransaction.findFirst.mockImplementation(async (args: any) => {
      if (args.where.type === "PAYMENT_PENDING_CREDIT") {
        return opts.credit ? { amount: opts.credit.amount, currency: opts.credit.currency } : null;
      }
      if (args.where.type === "PENDING_TO_AVAILABLE") {
        return opts.alreadyReleased ? { id: "rel-1" } : null;
      }
      return null;
    });
  }

  it("not yet dispatched (no PENDING_TO_AVAILABLE row): debits pendingBalance, not availableBalance", async () => {
    tx.refund.groupBy.mockResolvedValue([]);
    mockFindFirst({ credit: { amount: 5000, currency: "eur" }, alreadyReleased: false });
    tx.wallet.findUnique.mockResolvedValue({ id: "w-A", vendorId: "v-A" });

    await fire({ amount_refunded: 10000 });

    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: "w-A" }, data: { pendingBalance: { decrement: 5000 } } });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it("already dispatched (PENDING_TO_AVAILABLE row exists): claws back from availableBalance, guarded", async () => {
    tx.refund.groupBy.mockResolvedValue([]);
    mockFindFirst({ credit: { amount: 5000, currency: "eur" }, alreadyReleased: true });
    tx.wallet.findUnique.mockResolvedValue({ id: "w-A", vendorId: "v-A" });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });

    await fire({ amount_refunded: 10000 });

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "w-A", availableBalance: { gte: 5000 } },
      data: { availableBalance: { decrement: 5000 } },
    });
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  it("already dispatched but availableBalance is already spent (payout already taken): logs for manual reconciliation instead of going negative or throwing", async () => {
    tx.refund.groupBy.mockResolvedValue([]);
    mockFindFirst({ credit: { amount: 5000, currency: "eur" }, alreadyReleased: true });
    tx.wallet.findUnique.mockResolvedValue({ id: "w-A", vendorId: "v-A" });
    tx.wallet.updateMany.mockResolvedValue({ count: 0 }); // guard failed — insufficient availableBalance

    await expect(fire({ amount_refunded: 10000 })).resolves.toBeDefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Refund clawback exceeds available balance"),
      expect.objectContaining({ vendorId: "v-A", amount: 5000 }),
    );
  });
});
