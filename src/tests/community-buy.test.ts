import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
    campaignContribution: { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), groupBy: vi.fn() },
    campaignRefund: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
    campaignParticipant: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    notification: { findMany: vi.fn() },
    campaignExtensionRequest: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    campaignSupplierPayment: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    campaignFulfilment: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    organiserProfile: { findUnique: vi.fn(), update: vi.fn() },
    supplierProfile: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { refunds: { create: vi.fn() }, paymentIntents: { create: vi.fn(), retrieve: vi.fn() } },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

vi.mock("../modules/automation/automation.service", () => ({
  automationService: { scheduleAutomation: vi.fn() },
}));

vi.mock("../modules/community-buy/support-case.service", () => ({
  supportCaseService: { create: vi.fn(), adminUpdate: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { supportCaseService } from "../modules/community-buy/support-case.service";
import { stripe } from "../lib/stripe";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { organiserSupplierService } from "../modules/community-buy/organiser-supplier.service";

const m = vi.mocked(prisma, true);
const mSupportCase = vi.mocked(supportCaseService, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("communityCampaignsService.closeDueCampaigns — doc §7 deadline evaluation", () => {
  it("goal reached: minimum 3, goal 6, maximum 6, six confirmed -> GOAL_REACHED, FULFILLING, supplier order created", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-1", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 6, pricePerShareMinor: 1000, currency: "GBP", supplierId: "sup-1", title: "Six shares" },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", title: "Six shares", organiser: { userId: "organiser-1" }, participants: [] } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.supplierProfile.findUnique.mockResolvedValue({ vendor: { userId: "supplier-user-1", stripeAccountId: "acct_1" } } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result).toEqual({ closed: 1, succeeded: 1, failed: 0, rescued: 0 });
    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-1" }, data: expect.objectContaining({ status: "FULFILLING", fundingOutcome: "GOAL_REACHED" }) }),
    );
    expect(m.campaignSupplierPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 6000, currency: "GBP" }) }),
    );
  });

  it("minimum reached: minimum 3, goal 6, maximum 6, three confirmed -> MINIMUM_REACHED, supplier order for three", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-2", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 3, pricePerShareMinor: 1000, currency: "GBP", supplierId: "sup-1", title: "Three shares" },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-2", title: "Three shares", organiser: { userId: "organiser-1" }, participants: [] } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.supplierProfile.findUnique.mockResolvedValue({ vendor: { userId: "supplier-user-1", stripeAccountId: "acct_1" } } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result.succeeded).toBe(1);
    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FULFILLING", fundingOutcome: "MINIMUM_REACHED" }) }),
    );
    expect(m.campaignSupplierPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 3000 }) }),
    );
  });

  it("minimum reached: five of six confirmed -> MINIMUM_REACHED, supplier order for five (not six)", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-2b", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 5, pricePerShareMinor: 1000, currency: "GBP", supplierId: "sup-1", title: "Five shares" },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-2b", title: "Five shares", organiser: { userId: "organiser-1" }, participants: [] } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.supplierProfile.findUnique.mockResolvedValue({ vendor: { userId: "supplier-user-1", stripeAccountId: "acct_1" } } as never);

    await communityCampaignsService.closeDueCampaigns();

    expect(m.campaignSupplierPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 5000 }) }),
    );
  });

  it("below minimum: two of three confirmed at deadline -> RESCUE_WINDOW opens, no supplier order", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-3", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 2, rescueDurationMinutes: 2880, pricePerShareMinor: 1000, currency: "GBP", supplierId: "sup-1", title: "Two shares" },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-3", title: "Two shares", minimumShares: 3, confirmedShares: 2, organiser: { userId: "organiser-1" }, participants: [] } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result).toEqual({ closed: 1, succeeded: 0, failed: 0, rescued: 1 });
    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-3" }, data: expect.objectContaining({ status: "RESCUE_WINDOW" }) }),
    );
    expect(m.campaignSupplierPayment.create).not.toHaveBeenCalled();
  });

  it("does not create a duplicate refund record if one already exists (unique constraint)", async () => {
    m.campaignContribution.findMany.mockResolvedValue([{ id: "contrib-2", amount: 500, currency: "GBP" }] as never);
    m.campaignRefund.create.mockRejectedValue({ code: "P2002" });

    const created = await communityCampaignsService.createRefundRecordsForFailedCampaign("camp-3");

    expect(created).toBe(0);
    expect(m.campaignContribution.update).not.toHaveBeenCalled();
  });
});

describe("communityCampaignsService.evaluateRescueExpiry", () => {
  it("a top-up during the window pushed confirmed >= minimum -> succeeds, supplier order created", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-4", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 3, pricePerShareMinor: 1000, currency: "GBP", supplierId: "sup-1", title: "Rescued" },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-4", title: "Rescued", organiser: { userId: "organiser-1" }, participants: [] } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.supplierProfile.findUnique.mockResolvedValue({ vendor: { userId: "supplier-user-1", stripeAccountId: "acct_1" } } as never);

    const result = await communityCampaignsService.evaluateRescueExpiry();

    expect(result).toEqual({ rescued: 1, failed: 0 });
    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FULFILLING", fundingOutcome: "MINIMUM_REACHED" }) }),
    );
  });

  it("still below minimum when the rescue window expires -> FAILED, refunds created, no supplier order", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-5", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 2, title: "Failed rescue" },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-5", title: "Failed rescue", organiser: { userId: "organiser-1" }, participants: [] } as never);
    m.campaignContribution.findMany.mockResolvedValue([]);

    const result = await communityCampaignsService.evaluateRescueExpiry();

    expect(result).toEqual({ rescued: 0, failed: 1 });
    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", fundingOutcome: "BELOW_MINIMUM" }) }),
    );
    expect(m.campaignSupplierPayment.create).not.toHaveBeenCalled();
  });
});

describe("communityCampaignsService rescue-window organiser actions", () => {
  it("endRescueAndRefund moves RESCUE_WINDOW to FAILED and creates refund records", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-6", organiserId: "org-1", status: "RESCUE_WINDOW", title: "Ending" } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-6", status: "FAILED" } as never);
    m.campaignContribution.findMany.mockResolvedValue([{ id: "contrib-9", amount: 1200, currency: "GBP" }] as never);
    m.campaignRefund.create.mockResolvedValue({ id: "refund-9" } as never);
    m.campaignParticipant.findMany.mockResolvedValue([{ userId: "participant-1" }] as never);

    const result = await communityCampaignsService.endRescueAndRefund("organiser-user-1", "camp-6");

    expect(result.status).toBe("FAILED");
    expect(m.campaignRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contributionId: "contrib-9", idempotencyKey: "refund:contrib-9" }) }),
    );
  });

  it("endRescueAndRefund rejects a campaign that isn't in RESCUE_WINDOW", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-7", organiserId: "org-1", status: "LIVE" } as never);

    await expect(communityCampaignsService.endRescueAndRefund("organiser-user-1", "camp-7")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("requestExtension rejects a second extension — doc §8, one permitted maximum", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-8", organiserId: "org-1", status: "RESCUE_WINDOW", extensionCount: 1 } as never);

    await expect(
      communityCampaignsService.requestExtension("organiser-user-1", "camp-8", {
        requestedDeadline: new Date(Date.now() + 100000).toISOString(),
        reason: "need more time",
        supplierReconfirmed: true,
        priceUnchangedConfirmed: true,
        participantTermsUnchanged: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("approveExtension rejects when supplier reconfirmation is missing", async () => {
    m.campaignExtensionRequest.findUnique.mockResolvedValue({
      id: "ext-1", status: "PENDING", campaignId: "camp-9", supplierReconfirmed: false, priceUnchangedConfirmed: true,
      campaign: { extensionCount: 0 },
    } as never);

    await expect(communityCampaignsService.approveExtension("admin-1", "ext-1")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("campaignContributionsService.createContributionIntent", () => {
  it("refuses to start a payment when the market has not enabled Community Buy payments", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-10", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GB", currency: "GBP", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: false,
    } as never);

    await expect(
      campaignContributionsService.createContributionIntent("buyer-1", "camp-10", 1),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("rejects a contribution in a currency Stripe doesn't support, instead of silently charging EUR for the same numeric amount", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-11", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GH", currency: "GHS", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GH", communityBuyEnabled: true, communityBuyPaymentsEnabled: true,
    } as never);

    await expect(
      campaignContributionsService.createContributionIntent("buyer-1", "camp-11", 1),
    ).rejects.toMatchObject({ statusCode: 400, code: "CURRENCY_NOT_SUPPORTED" });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(m.campaignContribution.create).not.toHaveBeenCalled();
  });

  it("rejects a quantity that would exceed the campaign's remaining capacity", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-12", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GB", currency: "GBP", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 5,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true,
    } as never);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue({
      id: "camp-12", currency: "GBP", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 5,
    } as never);

    await expect(
      campaignContributionsService.createContributionIntent("buyer-1", "camp-12", 2),
    ).rejects.toMatchObject({ statusCode: 409, code: "CAPACITY_UNAVAILABLE" });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe("campaignContributionsService.createOrganiserTopUp", () => {
  it("rejects a top-up when the campaign isn't in its rescue window", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-13", organiserId: "org-1", status: "LIVE" } as never);

    await expect(campaignContributionsService.createOrganiserTopUp("organiser-user-1", "camp-13", 1)).rejects.toMatchObject({ statusCode: 409 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe("campaignContributionsService.requeryRefund — spec §130 recheck provider", () => {
  it("returns the refund unchanged when it's already REFUNDED — never re-refunds", async () => {
    m.campaignRefund.findUnique.mockResolvedValue({ id: "refund-1", status: "REFUNDED" } as never);

    const result = await campaignContributionsService.requeryRefund("refund-1");

    expect(result).toEqual({ id: "refund-1", status: "REFUNDED" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("retries the Stripe refund with the SAME idempotency key and marks REFUNDED on success", async () => {
    m.campaignRefund.findUnique.mockResolvedValue({
      id: "refund-2",
      status: "REFUND_FAILED",
      amount: 500,
      idempotencyKey: "idem-key-2",
      contributionId: "contrib-2",
      contribution: { stripePaymentIntentId: "pi_2", campaignId: "camp-2", participant: { userId: "buyer-2" } },
    } as never);
    vi.mocked(stripe.refunds.create).mockResolvedValue({ id: "re_2" } as never);
    m.campaignRefund.update.mockResolvedValue({ id: "refund-2", status: "REFUNDED" } as never);
    m.campaignContribution.update.mockResolvedValue({} as never);

    await campaignContributionsService.requeryRefund("refund-2");

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_2", amount: 500 },
      { idempotencyKey: "idem-key-2" },
    );
    expect(m.campaignRefund.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "refund-2" }, data: expect.objectContaining({ status: "REFUNDED", stripeRefundId: "re_2" }) }),
    );
  });

  it("marks REFUND_FAILED again (not throw) when the retry still fails", async () => {
    m.campaignRefund.findUnique.mockResolvedValue({
      id: "refund-3",
      status: "REFUND_FAILED",
      amount: 500,
      idempotencyKey: "idem-key-3",
      contributionId: "contrib-3",
      contribution: { stripePaymentIntentId: "pi_3", campaignId: "camp-3", participant: { userId: "buyer-3" } },
    } as never);
    vi.mocked(stripe.refunds.create).mockRejectedValue(new Error("card issuer declined"));
    m.campaignRefund.update.mockResolvedValue({ id: "refund-3", status: "REFUND_FAILED" } as never);

    const result = await campaignContributionsService.requeryRefund("refund-3");

    expect(result.status).toBe("REFUND_FAILED");
    expect(m.campaignRefund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "REFUND_FAILED", failureReason: "card issuer declined" } }),
    );
  });
});

describe("campaignContributionsService.escalateRefund — spec §130 escalate (reuses support-case system)", () => {
  it("opens a support case on behalf of the affected participant and marks it escalated", async () => {
    m.campaignRefund.findUnique.mockResolvedValue({
      id: "refund-4",
      status: "REFUND_FAILED",
      failureReason: "card issuer declined",
      contributionId: "contrib-4",
      contribution: { campaignId: "camp-4", participant: { userId: "buyer-4" }, campaign: { title: "Rice Bulk Buy" } },
    } as never);
    mSupportCase.create.mockResolvedValue({ id: "case-9" } as never);
    mSupportCase.adminUpdate.mockResolvedValue({ id: "case-9", escalated: true } as never);

    await campaignContributionsService.escalateRefund("admin-1", "refund-4");

    expect(mSupportCase.create).toHaveBeenCalledWith(
      "buyer-4",
      "camp-4",
      expect.objectContaining({ caseType: "REFUND_ISSUE" }),
    );
    expect(mSupportCase.adminUpdate).toHaveBeenCalledWith("admin-1", "case-9", { escalated: true });
  });
});

describe("campaignContributionsService.verifyContribution — concurrency-safe capacity claim", () => {
  it("marks PAID and increments confirmedShares when capacity is available", async () => {
    m.campaignContribution.findUnique.mockResolvedValue({
      id: "contrib-20", campaignId: "camp-14", quantity: 1, status: "PAYMENT_PROCESSING", stripePaymentIntentId: "pi_1", currency: "GBP", amount: 1000,
      participant: { userId: "buyer-1" },
    } as never);
    vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValue({ status: "succeeded" } as never);

    const txCampaign = { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-14", maximumShares: 6, confirmedShares: 5, termsLockedAt: new Date() }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() };
    const txContribution = { update: vi.fn() };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-20", status: "PAID" } as never);

    const result = await campaignContributionsService.verifyContribution("buyer-1", "contrib-20");

    expect(txCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-14", confirmedShares: { lte: 5 } }, data: { confirmedShares: { increment: 1 } } }),
    );
    expect(txContribution.update).toHaveBeenCalledWith({ where: { id: "contrib-20" }, data: { status: "PAID" } });
    expect(result.status).toBe("PAID");
  });

  it("concurrent final slot: when the atomic claim loses the race, the already-captured payment is queued for refund instead of over-counting capacity", async () => {
    m.campaignContribution.findUnique.mockResolvedValue({
      id: "contrib-21", campaignId: "camp-15", quantity: 1, status: "PAYMENT_PROCESSING", stripePaymentIntentId: "pi_2", currency: "GBP", amount: 1000,
      participant: { userId: "buyer-2" },
    } as never);
    vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValue({ status: "succeeded" } as never);

    // Another confirmation already claimed the last share inside the transaction.
    const txCampaign = { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-15", maximumShares: 6, confirmedShares: 6, termsLockedAt: new Date() }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
    m.$transaction
      .mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: { update: vi.fn() } }))
      .mockImplementationOnce(async (cb: any) => cb({ campaignContribution: { update: vi.fn() }, campaignRefund: { create: vi.fn().mockResolvedValue({ id: "refund-x" }) } }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-21", status: "REFUND_PENDING" } as never);

    const result = await campaignContributionsService.verifyContribution("buyer-2", "contrib-21");

    expect(result.status).toBe("REFUND_PENDING");
  });
});

describe("marketConfigurationService.isCommunityBuyPaymentsEnabled", () => {
  it("defaults to false — a brand new market never accepts contributions until an admin explicitly enables it", async () => {
    m.marketConfiguration.count.mockResolvedValue(1); // defaults already seeded elsewhere
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: false, communityBuyPaymentsEnabled: false,
    } as never);

    const enabled = await marketConfigurationService.isCommunityBuyPaymentsEnabled("GB");
    expect(enabled).toBe(false);
  });

  it("requires BOTH communityBuyEnabled and communityBuyPaymentsEnabled — one flag alone is not enough", async () => {
    m.marketConfiguration.count.mockResolvedValue(1);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: false,
    } as never);

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("GB")).toBe(false);
  });
});

describe("campaignContributionsService — financial ledger (read-only aggregation, doc §12)", () => {
  it("getLedgerSummaryForAdmin returns an empty list when nothing has ever moved money", async () => {
    m.campaignContribution.groupBy.mockResolvedValue([] as never);
    m.campaignRefund.groupBy.mockResolvedValue([] as never);
    m.campaignSupplierPayment.findMany.mockResolvedValue([] as never);

    const summary = await campaignContributionsService.getLedgerSummaryForAdmin();
    expect(summary).toEqual([]);
  });

  it("getLedgerSummaryForAdmin computes netPosition as contributed minus refunded minus paid to supplier", async () => {
    m.campaignContribution.groupBy.mockResolvedValue([
      { campaignId: "camp-1", _sum: { amount: 10000 }, _count: { id: 4 } },
    ] as never);
    m.campaignRefund.groupBy.mockResolvedValue([
      { contributionId: "contrib-1", _sum: { amount: 2500 } },
    ] as never);
    m.campaignContribution.findMany.mockResolvedValue([{ id: "contrib-1", campaignId: "camp-1" }] as never);
    m.campaignSupplierPayment.findMany.mockResolvedValue([{ campaignId: "camp-1", amount: 5000 }] as never);
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-1", title: "Rice bulk buy", currency: "GBP", status: "COMPLETED", fundingOutcome: "GOAL_REACHED" },
    ] as never);

    const summary = await campaignContributionsService.getLedgerSummaryForAdmin();
    expect(summary).toEqual([
      expect.objectContaining({
        campaignId: "camp-1",
        totalContributed: 10000,
        totalRefunded: 2500,
        totalPaidToSupplier: 5000,
        netPosition: 2500,
        contributionCount: 4,
      }),
    ]);
  });

  it("getCampaignLedger throws 404 for a campaign that doesn't exist", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(null);
    await expect(campaignContributionsService.getCampaignLedger("nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("getCampaignLedger returns itemized entries sorted chronologically with matching totals", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-2", title: "Spice bulk buy", currency: "GBP", status: "REFUNDING", fundingOutcome: "BELOW_MINIMUM",
    } as never);
    m.campaignContribution.findMany.mockResolvedValue([
      {
        id: "contrib-a", amount: 3000, quantity: 2, isOrganiserTopUp: false,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        participant: { user: { name: "Amina" } },
      },
    ] as never);
    m.campaignRefund.findMany.mockResolvedValue([
      {
        id: "refund-a", amount: 3000,
        updatedAt: new Date("2026-01-02T00:00:00Z"),
        contribution: { participant: { user: { name: "Amina" } } },
      },
    ] as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);

    const ledger = await campaignContributionsService.getCampaignLedger("camp-2");

    expect(ledger.entries.map((e: any) => e.type)).toEqual(["CONTRIBUTION", "REFUND"]);
    expect(ledger.entries[0].direction).toBe("CREDIT");
    expect(ledger.entries[1].direction).toBe("DEBIT");
    expect(ledger.totals).toEqual({
      totalContributed: 3000,
      totalRefunded: 3000,
      totalPaidToSupplier: 0,
      netPosition: 0,
    });
  });

});

describe("communityCampaignsService.update — 'Edit Live Campaign'", () => {
  it("allows full edits including financial terms while DRAFT and unlocked", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: null, goalShares: 10 } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1" } as never);

    await communityCampaignsService.update("organiser-user-1", "camp-1", { title: "New title", minimumShares: 5, goalShares: 10, pricePerShareMinor: 500 });

    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "New title", minimumShares: 5, pricePerShareMinor: 500 }) }),
    );
  });

  it("rejects any edit once terms are locked, even while still DRAFT", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: new Date() } as never);

    await expect(
      communityCampaignsService.update("organiser-user-1", "camp-1", { pricePerShareMinor: 999 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows a title/description-only edit while LIVE", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "LIVE", termsLockedAt: new Date() } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1" } as never);

    await communityCampaignsService.update("organiser-user-1", "camp-1", { title: "Corrected title", description: "Fixed a typo" });

    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { title: "Corrected title", description: "Fixed a typo" } }),
    );
  });

  it("rejects a financial-terms edit while LIVE, even though title/description edits are allowed", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "LIVE", termsLockedAt: new Date() } as never);

    await expect(
      communityCampaignsService.update("organiser-user-1", "camp-1", { title: "ok", pricePerShareMinor: 999 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("allows a content-only edit during RESCUE_WINDOW too", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "RESCUE_WINDOW", termsLockedAt: new Date() } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1" } as never);

    await communityCampaignsService.update("organiser-user-1", "camp-1", { description: "Almost there — thank you!" });

    expect(m.communityCampaign.update).toHaveBeenCalled();
  });

  it("rejects any edit once the campaign has reached a terminal state", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "COMPLETED", termsLockedAt: new Date() } as never);

    await expect(
      communityCampaignsService.update("organiser-user-1", "camp-1", { title: "too late" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("communityCampaignsService.listParticipantsForOrganiser — 'Participants'", () => {
  it("only returns participants with an actual PAID contribution, with real totals", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1" } as never);
    m.campaignParticipant.findMany.mockResolvedValue([
      {
        userId: "buyer-1",
        user: { name: "Amina", email: "amina@example.com" },
        joinedAt: new Date("2026-01-01"),
        contributions: [
          { quantity: 2, amount: 2000, isOrganiserTopUp: false, createdAt: new Date() },
          { quantity: 1, amount: 1000, isOrganiserTopUp: true, createdAt: new Date() },
        ],
      },
    ] as never);

    const result = await communityCampaignsService.listParticipantsForOrganiser("organiser-user-1", "camp-1");

    expect(result).toEqual([
      expect.objectContaining({ userId: "buyer-1", totalQuantity: 3, totalPaid: 3000, isOrganiser: true }),
    ]);
    expect(m.campaignParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: "camp-1", contributions: { some: { status: "PAID" } } } }),
    );
  });

  it("rejects a caller who doesn't own the campaign", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "someone-else" } as never);
    await expect(communityCampaignsService.listParticipantsForOrganiser("organiser-user-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.campaignParticipant.findMany).not.toHaveBeenCalled();
  });
});

describe("communityCampaignsService.getRefundProgressForOrganiser — 'Refund Progress'", () => {
  it("counts real refund records by status, never a fabricated percentage", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1" } as never);
    m.campaignRefund.findMany.mockResolvedValue([
      { status: "REFUNDED" }, { status: "REFUNDED" }, { status: "REFUND_PENDING" }, { status: "REFUND_FAILED" },
    ] as never);

    const result = await communityCampaignsService.getRefundProgressForOrganiser("organiser-user-1", "camp-1");

    expect(result).toEqual({ total: 4, completed: 2, pending: 1, failed: 1 });
  });

  it("returns all zeros when there are no refunds at all for this campaign", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1" } as never);
    m.campaignRefund.findMany.mockResolvedValue([] as never);

    const result = await communityCampaignsService.getRefundProgressForOrganiser("organiser-user-1", "camp-1");

    expect(result).toEqual({ total: 0, completed: 0, pending: 0, failed: 0 });
  });
});

describe("campaignContributionsService.getMyPaymentForCampaign — supplier's own payment view", () => {
  it("throws 404 when the vendor doesn't own the campaign's supplier profile", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "someone-else" } as never);
    await expect(campaignContributionsService.getMyPaymentForCampaign("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 404 when no payment record exists yet", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1" } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    await expect(campaignContributionsService.getMyPaymentForCampaign("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns the real payment record for the owning supplier", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1" } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue({ campaignId: "camp-1", status: "NOT_RELEASED", amount: 5000 } as never);
    const result = await campaignContributionsService.getMyPaymentForCampaign("vendor-1", "camp-1");
    expect(result).toEqual({ campaignId: "camp-1", status: "NOT_RELEASED", amount: 5000 });
  });
});

describe("Community Buy risk controls — restrict/unrestrict organiser and supplier", () => {
  const validInput = {
    supplierId: "sup-1",
    title: "Bulk rice buy",
    country: "GB",
    currency: "GBP",
    minimumShares: 5,
    goalShares: 10,
    maximumShares: 15,
    pricePerShareMinor: 1000,
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };

  it("organiserSupplierService.restrictOrganiser sets isRestricted and the reason", async () => {
    m.organiserProfile.update.mockResolvedValue({ id: "org-1", isRestricted: true, restrictedReason: "fraud report" } as never);
    const result = await organiserSupplierService.restrictOrganiser("org-1", "fraud report");
    expect(m.organiserProfile.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { isRestricted: true, restrictedReason: "fraud report" } });
    expect(result.isRestricted).toBe(true);
  });

  it("organiserSupplierService.unrestrictOrganiser clears isRestricted and the reason", async () => {
    m.organiserProfile.update.mockResolvedValue({ id: "org-1", isRestricted: false, restrictedReason: null } as never);
    await organiserSupplierService.unrestrictOrganiser("org-1");
    expect(m.organiserProfile.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { isRestricted: false, restrictedReason: null } });
  });

  it("organiserSupplierService.restrictSupplier / unrestrictSupplier mirror the organiser behavior", async () => {
    m.supplierProfile.update.mockResolvedValueOnce({ id: "sup-1", isRestricted: true } as never);
    await organiserSupplierService.restrictSupplier("sup-1", "quality complaints");
    expect(m.supplierProfile.update).toHaveBeenCalledWith({ where: { id: "sup-1" }, data: { isRestricted: true, restrictedReason: "quality complaints" } });

    m.supplierProfile.update.mockResolvedValueOnce({ id: "sup-1", isRestricted: false } as never);
    await organiserSupplierService.unrestrictSupplier("sup-1");
    expect(m.supplierProfile.update).toHaveBeenCalledWith({ where: { id: "sup-1" }, data: { isRestricted: false, restrictedReason: null } });
  });

  it("create() rejects a restricted organiser even though they're verified", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: true } as never);
    await expect(communityCampaignsService.create("organiser-user-1", validInput)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("create() rejects a restricted supplier even though they're verified", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);
    m.marketConfiguration.count.mockResolvedValue(1);
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", isVerified: true, isRestricted: true, country: "GB" } as never);
    await expect(communityCampaignsService.create("organiser-user-1", validInput)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("confirmSupplierCommitment rejects a restricted supplier", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", isRestricted: true } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1", status: "DRAFT" } as never);
    await expect(communityCampaignsService.confirmSupplierCommitment("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("listVerifiedSuppliers (organiser-facing picker) excludes restricted suppliers", async () => {
    m.supplierProfile.findMany.mockResolvedValue([] as never);
    await organiserSupplierService.listVerifiedSuppliers("GB");
    expect(m.supplierProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isVerified: true, isRestricted: false, country: "GB" } }),
    );
  });
});

describe("campaignContributionsService — financial ledger continued", () => {
  it("getCampaignLedger includes the supplier payment only when it has actually been PAID, not merely created", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-3", title: "Oil bulk buy", currency: "GBP", status: "FULFILLING", fundingOutcome: "GOAL_REACHED",
    } as never);
    m.campaignContribution.findMany.mockResolvedValue([] as never);
    m.campaignRefund.findMany.mockResolvedValue([] as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue({
      id: "sp-1", amount: 8000, status: "PROCESSING", updatedAt: new Date("2026-01-03T00:00:00Z"),
    } as never);

    const ledger = await campaignContributionsService.getCampaignLedger("camp-3");
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.totals.totalPaidToSupplier).toBe(0);
  });
});

describe("campaignContributionsService.listMyContributions — 'My Community Buys'", () => {
  it("excludes a joined campaign the user never actually contributed to (no PAID/attempted contribution)", async () => {
    m.campaignParticipant.findMany.mockResolvedValue([
      { campaign: { id: "camp-1" }, contributions: [] },
    ] as never);
    const result = await campaignContributionsService.listMyContributions("user-1");
    expect(result).toEqual([]);
  });

  it("sums quantity/amount across only PAID contributions and surfaces the highest-priority refund status", async () => {
    m.campaignParticipant.findMany.mockResolvedValue([
      {
        campaign: { id: "camp-1", title: "Rice bulk buy" },
        contributions: [
          { status: "PAID", quantity: 2, amount: 2000, createdAt: new Date("2026-01-02"), refund: null },
          { status: "PAID", quantity: 1, amount: 1000, createdAt: new Date("2026-01-01"), refund: { status: "REFUNDED" } },
          { status: "PAYMENT_FAILED", quantity: 1, amount: 1000, createdAt: new Date("2026-01-03"), refund: null },
        ],
      },
    ] as never);

    const result = await campaignContributionsService.listMyContributions("user-1");

    expect(result).toEqual([
      expect.objectContaining({
        totalQuantity: 3,
        totalPaid: 3000,
        refundStatus: "REFUNDED",
      }),
    ]);
  });

  it("prioritizes REFUND_FAILED over REFUNDED so a needs-attention case is never hidden behind an unrelated completed refund", async () => {
    m.campaignParticipant.findMany.mockResolvedValue([
      {
        campaign: { id: "camp-1" },
        contributions: [
          { status: "PAID", quantity: 1, amount: 1000, createdAt: new Date(), refund: { status: "REFUNDED" } },
          { status: "PAID", quantity: 1, amount: 1000, createdAt: new Date(), refund: { status: "REFUND_FAILED" } },
        ],
      },
    ] as never);

    const result = await campaignContributionsService.listMyContributions("user-1");
    expect(result[0].refundStatus).toBe("REFUND_FAILED");
  });
});

describe("communityCampaignsService.listMyCampaignUpdates — 'Campaign Updates'", () => {
  it("throws 404 for a campaign that doesn't exist", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(null);
    await expect(communityCampaignsService.listMyCampaignUpdates("user-1", "camp-x")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 403 for a user who is neither the organiser nor a participant", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ organiser: { userId: "someone-else" } } as never);
    m.campaignParticipant.findUnique.mockResolvedValue(null);
    await expect(communityCampaignsService.listMyCampaignUpdates("user-1", "camp-x")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.notification.findMany).not.toHaveBeenCalled();
  });

  it("returns updates for a participant, scoped to their own notifications for this campaign", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ organiser: { userId: "organiser-user" } } as never);
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "participant-1" } as never);
    m.notification.findMany.mockResolvedValue([{ id: "notif-1", title: "Campaign succeeded!" }] as never);

    const result = await communityCampaignsService.listMyCampaignUpdates("user-1", "camp-x");

    expect(m.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", type: "COMMUNITY_CAMPAIGN_UPDATE", data: { path: ["campaignId"], equals: "camp-x" } },
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("allows the organiser without requiring a separate participant row", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ organiser: { userId: "user-1" } } as never);
    m.notification.findMany.mockResolvedValue([] as never);

    await communityCampaignsService.listMyCampaignUpdates("user-1", "camp-x");

    expect(m.campaignParticipant.findUnique).not.toHaveBeenCalled();
  });
});
