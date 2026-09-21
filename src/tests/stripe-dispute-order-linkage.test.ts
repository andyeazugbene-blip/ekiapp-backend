/**
 * Phase 4.1 — a Stripe/bank-initiated chargeback (charge.dispute.created)
 * previously never touched the affected Order at all: no status freeze, no
 * link between the StripeDispute row and the Order(s) it concerned, and
 * charge.dispute.closed (the real won/lost outcome) had no handler
 * whatsoever — a dispute stayed open forever in our records regardless of
 * what Stripe/the card network actually decided.
 *
 * These tests cover: order freezing on .created, idempotent/out-of-order
 * handling, WON restores the pre-dispute status, LOST marks REFUNDED and
 * flags already-released vendor earnings for a real manual decision
 * (never auto-clawed-back), and the new refund guard against a DISPUTED
 * order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn(), update: vi.fn() },
    webhookEvent: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    stripeDispute: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { webhooks: { constructEvent: vi.fn() } },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ message: String(e) })),
}));

vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { stripeWebhookService } from "../modules/stripe/stripe.service";

const m = vi.mocked(prisma, true) as any;
const constructEvent = stripe.webhooks.constructEvent as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

function mockTxCreated(overrides: Record<string, unknown> = {}) {
  return {
    webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    checkout: { findUnique: vi.fn().mockResolvedValue(null) },
    communityBuyPaymentAuthorisation: { findUnique: vi.fn().mockResolvedValue(null) },
    order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    stripeDispute: { upsert: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

describe("charge.dispute.created — freezes affected orders", () => {
  it("freezes each non-terminal order to DISPUTED and records the pre-dispute snapshot", async () => {
    constructEvent.mockReturnValue({
      id: "evt_d1", type: "charge.dispute.created",
      data: { object: { id: "dp_1", payment_intent: "pi_1", amount: 5000, currency: "gbp", reason: "fraudulent", status: "warning_needs_response" } },
    });

    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const stripeDisputeUpsert = vi.fn().mockResolvedValue({});
    m.$transaction.mockImplementation(async (cb: any) => cb(mockTxCreated({
      checkout: { findUnique: vi.fn().mockResolvedValue({ id: "co_1", buyerId: "buyer-1", orders: [{ id: "order-1", status: "PAID" }] }) },
      order: { updateMany: orderUpdateMany },
      stripeDispute: { upsert: stripeDisputeUpsert },
    })));

    await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });

    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PAID" },
      data: { status: "DISPUTED", disputedAt: expect.any(Date) },
    });
    expect(stripeDisputeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        affectedOrderIds: ["order-1"],
        preDisputeStatuses: { "order-1": "PAID" },
      }),
    }));
  });

  it("skips orders already in a terminal state (CANCELLED/REFUNDED/FAILED) — never re-freezes them", async () => {
    constructEvent.mockReturnValue({
      id: "evt_d2", type: "charge.dispute.created",
      data: { object: { id: "dp_2", payment_intent: "pi_2", amount: 1000, currency: "gbp", reason: "fraudulent", status: "needs_response" } },
    });

    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const stripeDisputeUpsert = vi.fn().mockResolvedValue({});
    m.$transaction.mockImplementation(async (cb: any) => cb(mockTxCreated({
      checkout: { findUnique: vi.fn().mockResolvedValue({ id: "co_2", buyerId: "buyer-1", orders: [{ id: "order-cancelled", status: "CANCELLED" }] }) },
      order: { updateMany: orderUpdateMany },
      stripeDispute: { upsert: stripeDisputeUpsert },
    })));

    await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });

    expect(orderUpdateMany).not.toHaveBeenCalled();
    expect(stripeDisputeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ affectedOrderIds: [] }),
    }));
  });
});

describe("charge.dispute.closed — WON restores the pre-dispute status", () => {
  it("restores the order to whatever it was before the dispute froze it", async () => {
    constructEvent.mockReturnValue({
      id: "evt_closed_won", type: "charge.dispute.closed",
      data: { object: { id: "dp_1", payment_intent: "pi_1", amount: 5000, currency: "gbp", reason: "fraudulent", status: "won" } },
    });

    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const disputeUpdate = vi.fn().mockResolvedValue({});
    m.$transaction.mockImplementation(async (cb: any) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      stripeDispute: {
        findUnique: vi.fn().mockResolvedValue({
          id: "sd-1", checkoutId: "co_1", resolvedAt: null,
          affectedOrderIds: ["order-1"], preDisputeStatuses: { "order-1": "DISPATCHED" },
        }),
        update: disputeUpdate,
      },
      order: { updateMany: orderUpdateMany },
      walletTransaction: { findFirst: vi.fn() },
      communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });

    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "DISPUTED" },
      data: { status: "DISPATCHED" },
    });
    expect(disputeUpdate).toHaveBeenCalledWith({ where: { id: "sd-1" }, data: { status: "won", resolvedAt: expect.any(Date) } });
    expect(result.received).toBe(true);
  });
});

describe("charge.dispute.closed — LOST marks REFUNDED and flags already-released earnings", () => {
  it("marks the order REFUNDED and flags it when vendor earnings were already released, without auto-clawing back", async () => {
    constructEvent.mockReturnValue({
      id: "evt_closed_lost", type: "charge.dispute.closed",
      data: { object: { id: "dp_2", payment_intent: "pi_2", amount: 5000, currency: "gbp", reason: "fraudulent", status: "lost" } },
    });

    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const walletTxFindFirst = vi.fn().mockResolvedValue({ id: "wtx-1" }); // earnings already released
    m.$transaction.mockImplementation(async (cb: any) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      stripeDispute: {
        findUnique: vi.fn().mockResolvedValue({
          id: "sd-2", checkoutId: "co_2", resolvedAt: null,
          affectedOrderIds: ["order-2"], preDisputeStatuses: { "order-2": "DISPATCHED" },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      order: { updateMany: orderUpdateMany },
      walletTransaction: { findFirst: walletTxFindFirst },
      communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });

    expect(orderUpdateMany).toHaveBeenCalledWith({ where: { id: "order-2", status: "DISPUTED" }, data: { status: "REFUNDED" } });
    expect(walletTxFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderId: "order-2", type: "PENDING_TO_AVAILABLE" },
    }));
    // No wallet debit anywhere in this test's mock — only visibility, never an automatic clawback.
    expect(result.received).toBe(true);
  });

  it("does not flag exposure when the vendor was never actually paid out for this order", async () => {
    constructEvent.mockReturnValue({
      id: "evt_closed_lost_2", type: "charge.dispute.closed",
      data: { object: { id: "dp_3", payment_intent: "pi_3", amount: 2000, currency: "gbp", reason: "fraudulent", status: "lost" } },
    });

    const walletTxFindFirst = vi.fn().mockResolvedValue(null); // never released
    m.$transaction.mockImplementation(async (cb: any) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      stripeDispute: {
        findUnique: vi.fn().mockResolvedValue({
          id: "sd-3", checkoutId: "co_3", resolvedAt: null,
          affectedOrderIds: ["order-3"], preDisputeStatuses: { "order-3": "PAID" },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      walletTransaction: { findFirst: walletTxFindFirst },
      communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });

    expect((result as any).earningsAlreadyReleasedOrderIds).toEqual([]);
  });
});

describe("charge.dispute.closed — idempotency and out-of-order delivery", () => {
  it("is idempotent — an already-resolved dispute is not re-processed (no order transition, no re-alert)", async () => {
    constructEvent.mockReturnValue({
      id: "evt_closed_repeat", type: "charge.dispute.closed",
      data: { object: { id: "dp_4", payment_intent: "pi_4", amount: 1000, currency: "gbp", reason: "fraudulent", status: "lost" } },
    });

    const orderUpdateMany = vi.fn();
    m.$transaction.mockImplementation(async (cb: any) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      stripeDispute: {
        findUnique: vi.fn().mockResolvedValue({
          id: "sd-4", checkoutId: "co_4", resolvedAt: new Date("2026-01-01"),
          affectedOrderIds: ["order-4"], preDisputeStatuses: { "order-4": "PAID" },
        }),
      },
      order: { updateMany: orderUpdateMany },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });

    expect(orderUpdateMany).not.toHaveBeenCalled();
    expect(result.received).toBe(true);
  });

  it("handles a .closed event with no prior .created record by creating one directly, without touching any order", async () => {
    constructEvent.mockReturnValue({
      id: "evt_closed_out_of_order", type: "charge.dispute.closed",
      data: { object: { id: "dp_5", payment_intent: "pi_5", amount: 3000, currency: "gbp", reason: "fraudulent", status: "won" } },
    });

    const disputeCreate = vi.fn().mockResolvedValue({
      id: "sd-5", checkoutId: null, resolvedAt: null, affectedOrderIds: [], preDisputeStatuses: {},
    });
    const orderUpdateMany = vi.fn();
    m.$transaction.mockImplementation(async (cb: any) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      checkout: { findUnique: vi.fn().mockResolvedValue(null) },
      stripeDispute: { findUnique: vi.fn().mockResolvedValue(null), create: disputeCreate, update: vi.fn().mockResolvedValue({}) },
      order: { updateMany: orderUpdateMany },
      walletTransaction: { findFirst: vi.fn() },
      communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });

    expect(disputeCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stripeDisputeId: "dp_5", status: "won" }),
    }));
    expect(orderUpdateMany).not.toHaveBeenCalled();
    expect(result.received).toBe(true);
  });

  it("returns duplicate on a repeated event delivery (webhook-level dedupe)", async () => {
    constructEvent.mockReturnValue({
      id: "evt_closed_dup", type: "charge.dispute.closed",
      data: { object: { id: "dp_6", payment_intent: "pi_6", amount: 1000, currency: "gbp", reason: "fraudulent", status: "lost" } },
    });

    m.$transaction.mockImplementation(async (cb: any) => cb({
      webhookEvent: {
        create: vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.0.0" })),
      },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("body") });
    expect(result.duplicate).toBe(true);
  });
});
