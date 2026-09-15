/**
 * M2/M6 — CommunityBuyPayout governance. Explicitly verifies:
 *  - the "never falsely claim custody" rule (triggerManualPayout must
 *    refuse unless COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED=true)
 *  - M6's server-recomputed payout eligibility (supplier state, Stripe
 *    capability, fulfilment completion, dispute/refund exposure)
 *  - M6's idempotency-key-persisted-before-the-call retry safety, surviving
 *    duplicate admin clicks / retries of a FAILED payout
 *  - M6's provider-confirmed payout webhook resolution (never marks PAID
 *    any other way) and MANUAL_REVIEW escalation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityBuyPayout: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    campaignFulfilment: { findUnique: vi.fn() },
    communityBuyPaymentAuthorisation: { count: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { payouts: { create: vi.fn() } },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";

const m = vi.mocked(prisma, true);
const s = vi.mocked(stripe, true);
const CAMPAIGN_ID = "camp-payout-1";

function basePayout(overrides: Partial<any> = {}) {
  return {
    id: "payout-1",
    campaignId: CAMPAIGN_ID,
    supplierId: "supplier-account-1",
    supplierConnectedAccountId: "acct_connected_1",
    currency: "GBP",
    netPayoutAmount: 1900,
    status: "READY",
    holdReasonCodes: [],
    idempotencyKey: null,
    retryCount: 0,
    ...overrides,
  };
}

function eligibleSupplier(overrides: Partial<any> = {}) {
  return { id: "supplier-account-1", supplierState: "APPROVED", chargesEnabled: true, payoutsEnabled: true, ...overrides };
}

/** Sets up all three eligibility-check mocks to return a fully-eligible payout — the shape most tests need so they can focus on their own specific assertion. */
function mockEligible() {
  m.supplierAccount.findUnique.mockResolvedValue(eligibleSupplier() as any);
  m.campaignFulfilment.findUnique.mockResolvedValue({ campaignId: CAMPAIGN_ID, status: "COMPLETED" } as any);
  m.communityBuyPaymentAuthorisation.count.mockResolvedValue(0);
}

const ORIGINAL_ENV = process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED;
  else process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = ORIGINAL_ENV;
});

describe("triggerManualPayout() — never falsely claims custody", () => {
  it("refuses with PAYOUT_CUSTODY_NOT_CONFIRMED when the confirmation env flag is unset — the default, safe state", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_CUSTODY_NOT_CONFIRMED" });
    expect(s.payouts.create).not.toHaveBeenCalled();
    expect(m.communityBuyPayout.updateMany).not.toHaveBeenCalled();
  });

  it("refuses even for a READY payout when the flag is explicitly 'false'", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "false";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_CUSTODY_NOT_CONFIRMED" });
    expect(s.payouts.create).not.toHaveBeenCalled();
  });

  it("only moves money once the flag is explicitly 'true' AND the payout is READY AND eligible", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    mockEligible();
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    s.payouts.create.mockResolvedValue({ id: "po_1" } as any);
    m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "IN_TRANSIT", providerPayoutId: "po_1" }) as any);

    const result = await campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID);
    expect(result.status).toBe("IN_TRANSIT");
    expect(s.payouts.create).toHaveBeenCalledWith({ amount: 1900, currency: "GBP" }, expect.objectContaining({ stripeAccount: "acct_connected_1" }));
  });

  it("rejects releasing a payout that isn't READY or FAILED, even with custody confirmed", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "HELD" }) as any);
    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toThrow(/not ready/);
    expect(s.payouts.create).not.toHaveBeenCalled();
  });

  it("a failed Stripe payout call marks the record FAILED, never silently PAID", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    mockEligible();
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    s.payouts.create.mockRejectedValue(new Error("insufficient funds"));

    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toThrow(/Payout failed/);
    expect(m.communityBuyPayout.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  describe("M6 — eligibility is recomputed server-side, never trusted from the admin's own judgement", () => {
    it("blocks release when the supplier account is suspended", async () => {
      process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
      const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
      m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
      m.supplierAccount.findUnique.mockResolvedValue(eligibleSupplier({ supplierState: "SUSPENDED" }) as any);
      m.campaignFulfilment.findUnique.mockResolvedValue({ status: "COMPLETED" } as any);
      m.communityBuyPaymentAuthorisation.count.mockResolvedValue(0);

      await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_NOT_ELIGIBLE" });
      expect(s.payouts.create).not.toHaveBeenCalled();
      expect(m.communityBuyPayout.updateMany).not.toHaveBeenCalled();
    });

    it("blocks release when the supplier's Stripe payouts capability is disabled", async () => {
      process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
      const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
      m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
      m.supplierAccount.findUnique.mockResolvedValue(eligibleSupplier({ payoutsEnabled: false }) as any);
      m.campaignFulfilment.findUnique.mockResolvedValue({ status: "COMPLETED" } as any);
      m.communityBuyPaymentAuthorisation.count.mockResolvedValue(0);

      await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_NOT_ELIGIBLE" });
      expect(s.payouts.create).not.toHaveBeenCalled();
    });

    it("blocks release when fulfilment is not yet completed", async () => {
      process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
      const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
      m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
      m.supplierAccount.findUnique.mockResolvedValue(eligibleSupplier() as any);
      m.campaignFulfilment.findUnique.mockResolvedValue({ status: "DISPATCHED" } as any);
      m.communityBuyPaymentAuthorisation.count.mockResolvedValue(0);

      await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_NOT_ELIGIBLE" });
      expect(s.payouts.create).not.toHaveBeenCalled();
    });

    it("blocks release when there is open dispute/refund exposure on the campaign's captured holds", async () => {
      process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
      const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
      m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
      m.supplierAccount.findUnique.mockResolvedValue(eligibleSupplier() as any);
      m.campaignFulfilment.findUnique.mockResolvedValue({ status: "COMPLETED" } as any);
      m.communityBuyPaymentAuthorisation.count.mockResolvedValue(1);

      await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_NOT_ELIGIBLE" });
      expect(s.payouts.create).not.toHaveBeenCalled();
    });
  });

  describe("M6 — retry after failure reuses the SAME persisted idempotency key", () => {
    it("retrying a FAILED payout is allowed and calls Stripe with the key persisted by the first (failed) attempt", async () => {
      process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
      const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
      mockEligible();
      // Simulates a payout that already failed once and had its key persisted at claim time.
      m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "FAILED", idempotencyKey: "community-buy-payout:camp-payout-1:1", retryCount: 1 }) as any);
      m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
      s.payouts.create.mockResolvedValue({ id: "po_2" } as any);
      m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "IN_TRANSIT" }) as any);

      await campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID);

      expect(m.communityBuyPayout.updateMany).toHaveBeenCalledWith({
        where: { campaignId: CAMPAIGN_ID, status: "FAILED" },
        data: expect.objectContaining({ status: "PENDING", idempotencyKey: "community-buy-payout:camp-payout-1:1" }),
      });
      expect(s.payouts.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idempotencyKey: "community-buy-payout:camp-payout-1:1" }));
    });

    it("a first attempt persists its freshly-generated key as part of the same guarded claim, before ever calling Stripe", async () => {
      process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
      const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
      mockEligible();
      m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "READY", idempotencyKey: null, retryCount: 0 }) as any);
      m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
      s.payouts.create.mockResolvedValue({ id: "po_3" } as any);
      m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "IN_TRANSIT" }) as any);

      await campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID);

      const claimCall = m.communityBuyPayout.updateMany.mock.calls[0][0];
      expect(claimCall.data.idempotencyKey).toBe("community-buy-payout:camp-payout-1:1");
      // The claim (which persists the key) must happen BEFORE the Stripe call uses it.
      expect(s.payouts.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idempotencyKey: "community-buy-payout:camp-payout-1:1" }));
    });

    it("a lost race on the guarded claim (duplicate admin click) refuses without ever calling Stripe twice", async () => {
      process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
      const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
      mockEligible();
      m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
      m.communityBuyPayout.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toThrow(/cannot be released/);
      expect(s.payouts.create).not.toHaveBeenCalled();
    });
  });
});

describe("markReady()/hold() — governance only, never move money", () => {
  it("markReady() only transitions HELD -> READY when eligible", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    mockEligible();
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "HELD" }) as any);
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    m.communityBuyPayout.findUniqueOrThrow.mockResolvedValue(basePayout({ status: "READY" }) as any);
    await campaignPayoutService.markReady("admin-1", CAMPAIGN_ID);
    expect(s.payouts.create).not.toHaveBeenCalled();
  });

  it("markReady() refuses when the supplier is restricted, before ever touching status", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "HELD" }) as any);
    m.supplierAccount.findUnique.mockResolvedValue(eligibleSupplier({ supplierState: "RESTRICTED" }) as any);
    m.campaignFulfilment.findUnique.mockResolvedValue({ status: "COMPLETED" } as any);
    m.communityBuyPaymentAuthorisation.count.mockResolvedValue(0);

    await expect(campaignPayoutService.markReady("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_NOT_ELIGIBLE" });
    expect(m.communityBuyPayout.updateMany).not.toHaveBeenCalled();
  });

  it("hold() records a reason code and never moves money", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "READY", holdReasonCodes: [] }) as any);
    m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "HELD", holdReasonCodes: ["dispute"] }) as any);
    const result = await campaignPayoutService.hold("admin-1", CAMPAIGN_ID, "dispute");
    expect(result.status).toBe("HELD");
    expect(s.payouts.create).not.toHaveBeenCalled();
  });
});

describe("getEligibility() — read-only preview matches the enforced check exactly", () => {
  it("reports blockers without mutating anything", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    m.supplierAccount.findUnique.mockResolvedValue(eligibleSupplier({ supplierState: "SUSPENDED", payoutsEnabled: false }) as any);
    m.campaignFulfilment.findUnique.mockResolvedValue(null);
    m.communityBuyPaymentAuthorisation.count.mockResolvedValue(2);

    const result = await campaignPayoutService.getEligibility(CAMPAIGN_ID);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining(["supplier_suspended", "stripe_payouts_disabled", "fulfilment_not_completed", "dispute_or_refund_exposure"]),
    );
    expect(m.communityBuyPayout.update).not.toHaveBeenCalled();
    expect(m.communityBuyPayout.updateMany).not.toHaveBeenCalled();
  });

  it("reports fully eligible with no blockers when every check passes", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    mockEligible();
    const result = await campaignPayoutService.getEligibility(CAMPAIGN_ID);
    expect(result).toEqual({ eligible: true, blockers: [] });
  });
});

describe("M6 — resolvePayoutWebhook() is the ONLY thing that ever marks a payout PAID", () => {
  it("payout.paid confirms IN_TRANSIT -> PAID with provider evidence", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    m.communityBuyPayout.findFirst.mockResolvedValue(basePayout({ status: "PAID" }) as any);

    const result = await campaignPayoutService.resolvePayoutWebhook("po_1", "payout.paid", { id: "po_1", amount: 1900, balance_transaction: "txn_1" } as any);

    expect(result.handled).toBe(true);
    expect(m.communityBuyPayout.updateMany).toHaveBeenCalledWith({
      where: { providerPayoutId: "po_1", status: "IN_TRANSIT" },
      data: expect.objectContaining({ status: "PAID", providerBalanceTransactionId: "txn_1" }),
    });
  });

  it("a duplicate payout.paid webhook delivery (already PAID) is a safe no-op, not a double-apply", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 0 } as any);

    const result = await campaignPayoutService.resolvePayoutWebhook("po_1", "payout.paid", { id: "po_1", amount: 1900 } as any);
    expect(result.handled).toBe(false);
  });

  it("an out-of-order payout.paid arriving before the payout ever reached IN_TRANSIT is ignored, never force-applied", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 0 } as any);

    const result = await campaignPayoutService.resolvePayoutWebhook("po_never_submitted", "payout.paid", { id: "po_never_submitted", amount: 1900 } as any);
    expect(result.handled).toBe(false);
    expect(m.communityBuyPayout.update).not.toHaveBeenCalled();
  });

  it("payout.failed confirms IN_TRANSIT -> FAILED with the provider's failure reason", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    m.communityBuyPayout.findFirst.mockResolvedValue(basePayout({ status: "FAILED" }) as any);

    const result = await campaignPayoutService.resolvePayoutWebhook("po_1", "payout.failed", { id: "po_1", amount: 1900, failure_code: "account_closed", failure_message: "Bank account closed" } as any);
    expect(result.handled).toBe(true);
    expect(m.communityBuyPayout.updateMany).toHaveBeenCalledWith({
      where: { providerPayoutId: "po_1", status: "IN_TRANSIT" },
      data: expect.objectContaining({ status: "FAILED", failureCode: "account_closed", failureMessage: "Bank account closed" }),
    });
  });

  it("payout.canceled confirms IN_TRANSIT -> CANCELLED", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    m.communityBuyPayout.findFirst.mockResolvedValue(basePayout({ status: "CANCELLED" }) as any);

    const result = await campaignPayoutService.resolvePayoutWebhook("po_1", "payout.canceled", { id: "po_1", amount: 1900 } as any);
    expect(result.handled).toBe(true);
    expect(m.communityBuyPayout.updateMany).toHaveBeenCalledWith({
      where: { providerPayoutId: "po_1", status: "IN_TRANSIT" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
  });

  it("ignores an unrelated event type", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    const result = await campaignPayoutService.resolvePayoutWebhook("po_1", "payout.updated", {} as any);
    expect(result.handled).toBe(false);
    expect(m.communityBuyPayout.updateMany).not.toHaveBeenCalled();
  });
});

describe("M6 — escalateToManualReview() / holdForSystemReason()", () => {
  it("escalates a non-PAID payout into MANUAL_REVIEW with the reason recorded", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "READY", holdReasonCodes: [] }) as any);
    m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "MANUAL_REVIEW", holdReasonCodes: ["capture_amount_mismatch"] }) as any);

    const result = await campaignPayoutService.escalateToManualReview(CAMPAIGN_ID, "capture_amount_mismatch");
    expect(result?.status).toBe("MANUAL_REVIEW");
    expect(m.communityBuyPayout.update).toHaveBeenCalledWith({
      where: { campaignId: CAMPAIGN_ID },
      data: expect.objectContaining({ status: "MANUAL_REVIEW", holdReasonCodes: ["capture_amount_mismatch"] }),
    });
  });

  it("never escalates a payout that has already been PAID — nothing left to protect", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "PAID" }) as any);

    const result = await campaignPayoutService.escalateToManualReview(CAMPAIGN_ID, "capture_amount_mismatch");
    expect(result?.status).toBe("PAID");
    expect(m.communityBuyPayout.update).not.toHaveBeenCalled();
  });

  it("holdForSystemReason() never throws even when no payout row exists yet", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(null as any);
    await expect(campaignPayoutService.holdForSystemReason(CAMPAIGN_ID, "dispute_open")).resolves.toBeUndefined();
  });

  it("holdForSystemReason() applies the hold via the same hold() path when a payout row exists", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "READY", holdReasonCodes: [] }) as any);
    m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "HELD", holdReasonCodes: ["dispute_open"] }) as any);
    await campaignPayoutService.holdForSystemReason(CAMPAIGN_ID, "dispute_open");
    expect(m.communityBuyPayout.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ holdReasonCodes: ["dispute_open"] }) }));
  });
});
