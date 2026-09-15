/**
 * M6 — stripe.service.ts wiring for Community Buy's payout/dispute/refund
 * webhook resolution. Isolates the DISPATCH logic (which event types route
 * where, dedup/idempotency, never-throws-on-side-effect-failure) from the
 * business logic itself (already covered by community-buy-payout.test.ts
 * and campaign-authorisation.service.ts's own tests) by mocking
 * campaignPayoutService and campaignAuthorisationService as black boxes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    webhookEvent: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    checkout: { findUnique: vi.fn() },
    payment: { findFirst: vi.fn() },
    order: { updateMany: vi.fn() },
    communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
    stripeDispute: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { webhooks: { constructEvent: vi.fn() } },
}));

vi.mock("../config/env", () => ({
  env: { stripeWebhookSecret: "whsec_test", stripeIdentityWebhookSecret: "whsec_identity_test" },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ message: String(e) })),
}));

vi.mock("../modules/community-buy/campaign-payout.service", () => ({
  campaignPayoutService: { resolvePayoutWebhook: vi.fn().mockResolvedValue({ handled: true }), holdForSystemReason: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../modules/community-buy/campaign-authorisation.service", () => ({
  campaignAuthorisationService: { markCaptureDisputed: vi.fn().mockResolvedValue({ campaignId: "camp-1" }), markCaptureRefunded: vi.fn().mockResolvedValue({ campaignId: "camp-1" }) },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { stripeWebhookService } from "../modules/stripe/stripe.service";
import { campaignPayoutService } from "../modules/community-buy/campaign-payout.service";
import { campaignAuthorisationService } from "../modules/community-buy/campaign-authorisation.service";

const m = vi.mocked(prisma, true);
const constructEvent = vi.mocked(stripe.webhooks.constructEvent);
const $transaction = m.$transaction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

function mockDedupTransaction() {
  $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
    const tx = { webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) } };
    return cb(tx);
  });
}

describe("payout.paid / payout.failed / payout.canceled dispatch", () => {
  it("routes payout.paid to campaignPayoutService.resolvePayoutWebhook", async () => {
    constructEvent.mockReturnValue({ id: "evt_1", type: "payout.paid", data: { object: { id: "po_1", amount: 1900 } } } as never);
    mockDedupTransaction();

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });

    expect(result.received).toBe(true);
    expect(campaignPayoutService.resolvePayoutWebhook).toHaveBeenCalledWith("po_1", "payout.paid", expect.objectContaining({ id: "po_1" }));
  });

  it("routes payout.failed to campaignPayoutService.resolvePayoutWebhook", async () => {
    constructEvent.mockReturnValue({ id: "evt_2", type: "payout.failed", data: { object: { id: "po_2", amount: 1900 } } } as never);
    mockDedupTransaction();

    await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });
    expect(campaignPayoutService.resolvePayoutWebhook).toHaveBeenCalledWith("po_2", "payout.failed", expect.objectContaining({ id: "po_2" }));
  });

  it("a duplicate delivery of the same payout event is a no-op — dispatch never re-runs the business logic", async () => {
    constructEvent.mockReturnValue({ id: "evt_dup", type: "payout.paid", data: { object: { id: "po_3", amount: 1900 } } } as never);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = { webhookEvent: { create: vi.fn().mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" })) } };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });
    expect(result.duplicate).toBe(true);
    expect(campaignPayoutService.resolvePayoutWebhook).not.toHaveBeenCalled();
  });
});

describe("charge.dispute.created — Community Buy Direct Charge resolution", () => {
  it("flags a Community Buy hold as DISPUTED and auto-holds its payout when no Checkout matches the payment intent", async () => {
    constructEvent.mockReturnValue({
      id: "evt_dispute", type: "charge.dispute.created",
      data: { object: { id: "dp_1", payment_intent: "pi_cb_1", amount: 1900, currency: "gbp", reason: "fraudulent", status: "needs_response" } },
    } as never);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        checkout: { findUnique: vi.fn().mockResolvedValue(null) },
        communityBuyPaymentAuthorisation: { findUnique: vi.fn().mockResolvedValue({ campaignId: "camp-1" }) },
        stripeDispute: { upsert: vi.fn().mockResolvedValue({}) },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });

    expect(result.received).toBe(true);
    expect(campaignAuthorisationService.markCaptureDisputed).toHaveBeenCalledWith("pi_cb_1");
    expect(campaignPayoutService.holdForSystemReason).toHaveBeenCalledWith("camp-1", "dispute_open");
  });

  it("never re-throws when the post-commit Community Buy resolution itself fails — the webhook is already acknowledged", async () => {
    constructEvent.mockReturnValue({
      id: "evt_dispute_2", type: "charge.dispute.created",
      data: { object: { id: "dp_2", payment_intent: "pi_cb_2", amount: 1900, currency: "gbp", reason: "fraudulent", status: "needs_response" } },
    } as never);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        checkout: { findUnique: vi.fn().mockResolvedValue(null) },
        communityBuyPaymentAuthorisation: { findUnique: vi.fn().mockResolvedValue({ campaignId: "camp-2" }) },
        stripeDispute: { upsert: vi.fn().mockResolvedValue({}) },
      };
      return cb(tx);
    });
    vi.mocked(campaignAuthorisationService.markCaptureDisputed).mockRejectedValueOnce(new Error("boom"));

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });
    expect(result.received).toBe(true);
  });

  it("regular commerce disputes (a real Checkout match) are unaffected — Community Buy resolution is never called", async () => {
    constructEvent.mockReturnValue({
      id: "evt_dispute_3", type: "charge.dispute.created",
      data: { object: { id: "dp_3", payment_intent: "pi_regular", amount: 1900, currency: "gbp", reason: "fraudulent", status: "needs_response" } },
    } as never);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        checkout: { findUnique: vi.fn().mockResolvedValue({ id: "co_1", buyerId: "buyer-1" }) },
        stripeDispute: { upsert: vi.fn().mockResolvedValue({}) },
      };
      return cb(tx);
    });

    await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });
    expect(campaignAuthorisationService.markCaptureDisputed).not.toHaveBeenCalled();
    expect(campaignPayoutService.holdForSystemReason).not.toHaveBeenCalled();
  });
});

describe("charge.refunded — Community Buy Direct Charge resolution", () => {
  it("flags a Community Buy hold as REFUNDED and auto-holds its payout when no Checkout/Payment matches", async () => {
    constructEvent.mockReturnValue({
      id: "evt_refund", type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: "pi_cb_3" } },
    } as never);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        checkout: { findUnique: vi.fn().mockResolvedValue(null) },
        payment: { findFirst: vi.fn().mockResolvedValue(null) },
        communityBuyPaymentAuthorisation: { findUnique: vi.fn().mockResolvedValue({ campaignId: "camp-3" }) },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });

    expect(result.received).toBe(true);
    expect(campaignAuthorisationService.markCaptureRefunded).toHaveBeenCalledWith("pi_cb_3");
    expect(campaignPayoutService.holdForSystemReason).toHaveBeenCalledWith("camp-3", "capture_refunded");
  });

  it("does nothing Community-Buy-specific when the payment intent matches neither Checkout, Payment, nor a Community Buy hold", async () => {
    constructEvent.mockReturnValue({
      id: "evt_refund_2", type: "charge.refunded",
      data: { object: { id: "ch_2", payment_intent: "pi_unknown" } },
    } as never);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        checkout: { findUnique: vi.fn().mockResolvedValue(null) },
        payment: { findFirst: vi.fn().mockResolvedValue(null) },
        communityBuyPaymentAuthorisation: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "sig", rawBody: Buffer.from("x") });
    expect(result.received).toBe(true);
    expect(campaignAuthorisationService.markCaptureRefunded).not.toHaveBeenCalled();
  });
});
