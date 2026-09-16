/**
 * M6 — Community Buy reconciliation (retrieve-per-record strategy across
 * captured Direct Charge holds, legacy PLEDGE_THEN_CHARGE transfers, and
 * manual CommunityBuyPayout payouts). Verifies:
 *  - zero-migration reuse of ReconciliationRun/ReconciliationDifference
 *  - every difference kind (AMOUNT_MISMATCH/STATUS_MISMATCH/MISSING_AT_PROVIDER)
 *  - genuine mismatches escalate the CommunityBuyPayout into MANUAL_REVIEW,
 *    never silently auto-corrected
 *  - a payout stuck IN_TRANSIT with a provider-confirmed outcome self-heals
 *    via the SAME guarded resolvePayoutWebhook() a real webhook would use
 *  - period validation matches the existing ledger reconciliation service
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityBuyPaymentAuthorisation: { findMany: vi.fn() },
    campaignSupplierPayment: { findMany: vi.fn() },
    communityBuyPayout: { findMany: vi.fn() },
    reconciliationRun: { create: vi.fn(), update: vi.fn() },
    reconciliationDifference: { createMany: vi.fn() },
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: {
    paymentIntents: { retrieve: vi.fn() },
    transfers: { retrieve: vi.fn() },
    payouts: { retrieve: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../modules/community-buy/campaign-payout.service", () => ({
  campaignPayoutService: {
    escalateToManualReview: vi.fn().mockResolvedValue(undefined),
    markReversed: vi.fn().mockResolvedValue(undefined),
    resolvePayoutWebhook: vi.fn().mockResolvedValue({ handled: true }),
  },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { communityBuyReconciliationService } from "../modules/community-buy/community-buy-reconciliation.service";
import { campaignPayoutService } from "../modules/community-buy/campaign-payout.service";

const m = vi.mocked(prisma, true);
const s = vi.mocked(stripe, true);

const PERIOD_START = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-09-08T00:00:00.000Z");

function resourceMissing() {
  return Object.assign(new Error("No such payment_intent"), { code: "resource_missing" });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([] as any);
  m.campaignSupplierPayment.findMany.mockResolvedValue([] as any);
  m.communityBuyPayout.findMany.mockResolvedValue([] as any);
  m.reconciliationRun.create.mockResolvedValue({ id: "run-1" } as any);
  m.reconciliationRun.update.mockImplementation(async ({ data }: any) => ({ id: "run-1", ...data, differences: [] }) as any);
  m.reconciliationDifference.createMany.mockResolvedValue({ count: 0 } as any);
});

describe("period validation — mirrors ledger/reconciliation.service.ts", () => {
  it("rejects periodEnd <= periodStart", async () => {
    await expect(communityBuyReconciliationService.runReconciliation(PERIOD_END, PERIOD_START)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a period longer than 31 days", async () => {
    const farEnd = new Date(PERIOD_START.getTime() + 40 * 24 * 60 * 60 * 1000);
    await expect(communityBuyReconciliationService.runReconciliation(PERIOD_START, farEnd)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("happy path — nothing to reconcile", () => {
  it("completes with zero differences and totalChecked 0", async () => {
    const run = await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);
    expect(run.status).toBe("COMPLETED");
    expect(m.reconciliationDifference.createMany).not.toHaveBeenCalled();
    expect(m.reconciliationRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED", totalChecked: 0 }) }));
  });

  it("tags the run with the distinguishing provider string, never colliding with plain 'stripe'", async () => {
    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);
    expect(m.reconciliationRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ provider: "stripe-community-buy" }) }));
  });
});

describe("captured holds (Direct Charge PaymentIntents, connected-account scoped)", () => {
  it("flags an amount mismatch and escalates the campaign's payout to MANUAL_REVIEW", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "hold-1", campaignId: "camp-1", paymentIntentId: "pi_1", supplierConnectedAccountId: "acct_1", authorisedAmount: 5000, consentedChargeAmount: 5000 },
    ] as any);
    s.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded", amount_received: 4900 } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(s.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1", { stripeAccount: "acct_1" });
    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "AMOUNT_MISMATCH", businessRefType: "CommunityBuyPaymentAuthorisation", expectedAmount: 5000, actualAmount: 4900 })]),
    }));
    expect(campaignPayoutService.escalateToManualReview).toHaveBeenCalledWith("camp-1", "capture_amount_mismatch");
  });

  it("flags a status mismatch when the provider PaymentIntent isn't actually succeeded", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "hold-2", campaignId: "camp-2", paymentIntentId: "pi_2", supplierConnectedAccountId: "acct_2", authorisedAmount: 5000, consentedChargeAmount: 5000 },
    ] as any);
    s.paymentIntents.retrieve.mockResolvedValue({ status: "requires_capture", amount_received: 0 } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "STATUS_MISMATCH", businessRefType: "CommunityBuyPaymentAuthorisation" })]),
    }));
    expect(campaignPayoutService.escalateToManualReview).toHaveBeenCalledWith("camp-2", "capture_status_mismatch");
  });

  it("flags MISSING_AT_PROVIDER when Stripe has no record of the PaymentIntent at all", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "hold-3", campaignId: "camp-3", paymentIntentId: "pi_3", supplierConnectedAccountId: "acct_3", authorisedAmount: 5000, consentedChargeAmount: 5000 },
    ] as any);
    s.paymentIntents.retrieve.mockRejectedValue(resourceMissing());

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "MISSING_AT_PROVIDER", businessRefType: "CommunityBuyPaymentAuthorisation" })]),
    }));
    expect(campaignPayoutService.escalateToManualReview).toHaveBeenCalledWith("camp-3", "capture_missing_at_provider");
  });

  it("a genuinely matching capture produces no difference at all", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "hold-4", campaignId: "camp-4", paymentIntentId: "pi_4", supplierConnectedAccountId: "acct_4", authorisedAmount: 5000, consentedChargeAmount: 5000 },
    ] as any);
    s.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded", amount_received: 5000 } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);
    expect(m.reconciliationDifference.createMany).not.toHaveBeenCalled();
    expect(campaignPayoutService.escalateToManualReview).not.toHaveBeenCalled();
  });

  it("a genuine (non-resource_missing) provider error fails the whole run rather than being swallowed", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "hold-5", campaignId: "camp-5", paymentIntentId: "pi_5", supplierConnectedAccountId: "acct_5", authorisedAmount: 5000, consentedChargeAmount: 5000 },
    ] as any);
    s.paymentIntents.retrieve.mockRejectedValue(new Error("Stripe is down"));

    await expect(communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END)).rejects.toThrow("Stripe is down");
    expect(m.reconciliationRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });
});

describe("legacy PLEDGE_THEN_CHARGE transfers (platform-level Transfer, no stripeAccount header)", () => {
  it("compares against netAmount (post-fee), never the gross collected amount", async () => {
    m.campaignSupplierPayment.findMany.mockResolvedValue([
      { id: "pay-1", campaignId: "camp-6", stripeTransferId: "tr_1", amount: 10000, feeAmount: 500, netAmount: 9500 },
    ] as any);
    s.transfers.retrieve.mockResolvedValue({ amount: 9500, reversed: false } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(s.transfers.retrieve).toHaveBeenCalledWith("tr_1");
    expect(m.reconciliationDifference.createMany).not.toHaveBeenCalled();
  });

  it("flags an amount mismatch against netAmount", async () => {
    m.campaignSupplierPayment.findMany.mockResolvedValue([
      { id: "pay-2", campaignId: "camp-7", stripeTransferId: "tr_2", amount: 10000, feeAmount: 500, netAmount: 9500 },
    ] as any);
    s.transfers.retrieve.mockResolvedValue({ amount: 9000, reversed: false } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "AMOUNT_MISMATCH", businessRefType: "CampaignSupplierPayment", expectedAmount: 9500, actualAmount: 9000 })]),
    }));
    // Never mutates CampaignSupplierPayment or CommunityBuyPayout — flagged only.
    expect(campaignPayoutService.escalateToManualReview).not.toHaveBeenCalled();
  });

  it("flags a reversed transfer even when the amount still matches", async () => {
    m.campaignSupplierPayment.findMany.mockResolvedValue([
      { id: "pay-3", campaignId: "camp-8", stripeTransferId: "tr_3", amount: 10000, feeAmount: 500, netAmount: 9500 },
    ] as any);
    s.transfers.retrieve.mockResolvedValue({ amount: 9500, reversed: true } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "STATUS_MISMATCH", businessRefType: "CampaignSupplierPayment" })]),
    }));
  });
});

describe("CommunityBuyPayout reconciliation (connected-account Payout)", () => {
  it("self-heals a payout stuck IN_TRANSIT whose provider status is actually 'paid' — via the SAME guarded resolvePayoutWebhook()", async () => {
    m.communityBuyPayout.findMany.mockResolvedValue([
      { id: "payout-1", campaignId: "camp-9", providerPayoutId: "po_1", supplierConnectedAccountId: "acct_9", status: "IN_TRANSIT", netPayoutAmount: 1900 },
    ] as any);
    s.payouts.retrieve.mockResolvedValue({ id: "po_1", status: "paid", amount: 1900 } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(campaignPayoutService.resolvePayoutWebhook).toHaveBeenCalledWith("po_1", "payout.paid", expect.objectContaining({ status: "paid" }));
    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "STATUS_MISMATCH", status: "RESOLVED" })]),
    }));
    expect(campaignPayoutService.escalateToManualReview).not.toHaveBeenCalled();
  });

  it("AT-36: marks a locally-PAID payout REVERSED when contradicted by the provider — never silently corrected, never uses the inert escalateToManualReview() (which refuses to touch an already-PAID payout)", async () => {
    m.communityBuyPayout.findMany.mockResolvedValue([
      { id: "payout-2", campaignId: "camp-10", providerPayoutId: "po_2", supplierConnectedAccountId: "acct_10", status: "PAID", netPayoutAmount: 1900 },
    ] as any);
    s.payouts.retrieve.mockResolvedValue({ id: "po_2", status: "failed", amount: 1900 } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(campaignPayoutService.resolvePayoutWebhook).not.toHaveBeenCalled();
    expect(campaignPayoutService.markReversed).toHaveBeenCalledWith("camp-10", "payout_status_mismatch");
    expect(campaignPayoutService.escalateToManualReview).not.toHaveBeenCalled();
    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "STATUS_MISMATCH", status: "OPEN" })]),
    }));
  });

  it("AT-36: marks a PAID payout REVERSED on an amount mismatch too", async () => {
    m.communityBuyPayout.findMany.mockResolvedValue([
      { id: "payout-3", campaignId: "camp-11", providerPayoutId: "po_3", supplierConnectedAccountId: "acct_11", status: "PAID", netPayoutAmount: 1900 },
    ] as any);
    s.payouts.retrieve.mockResolvedValue({ id: "po_3", status: "paid", amount: 1800 } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(campaignPayoutService.markReversed).toHaveBeenCalledWith("camp-11", "payout_amount_mismatch");
    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "AMOUNT_MISMATCH", businessRefType: "CommunityBuyPayout" })]),
    }));
  });

  it("does not escalate an IN_TRANSIT amount mismatch on its own (no confirmed contradiction yet)", async () => {
    m.communityBuyPayout.findMany.mockResolvedValue([
      { id: "payout-4", campaignId: "camp-12", providerPayoutId: "po_4", supplierConnectedAccountId: "acct_12", status: "IN_TRANSIT", netPayoutAmount: 1900 },
    ] as any);
    s.payouts.retrieve.mockResolvedValue({ id: "po_4", status: "pending", amount: 1800 } as any);

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "AMOUNT_MISMATCH", businessRefType: "CommunityBuyPayout" })]),
    }));
    expect(campaignPayoutService.escalateToManualReview).not.toHaveBeenCalled();
  });

  it("flags MISSING_AT_PROVIDER and escalates when Stripe has no record of the payout", async () => {
    m.communityBuyPayout.findMany.mockResolvedValue([
      { id: "payout-5", campaignId: "camp-13", providerPayoutId: "po_5", supplierConnectedAccountId: "acct_13", status: "IN_TRANSIT", netPayoutAmount: 1900 },
    ] as any);
    s.payouts.retrieve.mockRejectedValue(resourceMissing());

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ kind: "MISSING_AT_PROVIDER", businessRefType: "CommunityBuyPayout" })]),
    }));
    expect(campaignPayoutService.escalateToManualReview).toHaveBeenCalledWith("camp-13", "payout_missing_at_provider");
  });

  it("AT-36: a PAID payout that's gone missing at the provider is marked REVERSED, not MANUAL_REVIEW", async () => {
    m.communityBuyPayout.findMany.mockResolvedValue([
      { id: "payout-6", campaignId: "camp-14", providerPayoutId: "po_6", supplierConnectedAccountId: "acct_14", status: "PAID", netPayoutAmount: 1900 },
    ] as any);
    s.payouts.retrieve.mockRejectedValue(resourceMissing());

    await communityBuyReconciliationService.runReconciliation(PERIOD_START, PERIOD_END);

    expect(campaignPayoutService.markReversed).toHaveBeenCalledWith("camp-14", "payout_missing_at_provider");
    expect(campaignPayoutService.escalateToManualReview).not.toHaveBeenCalled();
  });
});
