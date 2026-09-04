import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
    campaignContribution: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
    campaignChargeAttempt: { create: vi.fn(), update: vi.fn(), count: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    campaignRefund: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
    campaignParticipant: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    buyerPaymentMethod: { findUnique: vi.fn() },
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: { create: vi.fn(), findMany: vi.fn() },
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
  stripe: { refunds: { create: vi.fn() }, paymentIntents: { create: vi.fn(), retrieve: vi.fn() }, transfers: { create: vi.fn() } },
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
import { notificationsService } from "../modules/notifications/notifications.service";
import { stripe } from "../lib/stripe";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { organiserSupplierService } from "../modules/community-buy/organiser-supplier.service";

const m = vi.mocked(prisma, true);
const mSupportCase = vi.mocked(supportCaseService, true);

beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults for the charge-batch machinery that now runs on every
  // campaign-success path (chargePledgesAfterSuccess) — most tests below
  // don't care about pledge charging and would otherwise crash iterating
  // an unmocked (undefined) findMany result. Tests that DO care override
  // these explicitly.
  m.campaignContribution.findMany.mockResolvedValue([] as never);
  m.campaignContribution.aggregate.mockResolvedValue({ _sum: { amount: 0 } } as never);
  m.campaignChargeAttempt.count.mockResolvedValue(0 as never);
  m.campaignContribution.updateMany.mockResolvedValue({ count: 0 } as never);
  m.ledgerAccount.findUnique.mockResolvedValue(null as never);
  m.ledgerAccount.create.mockImplementation(async ({ data }: any) => ({ id: `acct:${data.type}:${data.ownerId ?? "PLATFORM"}` }) as never);
  m.ledgerEntry.create.mockResolvedValue({ id: "entry-1" } as never);
});

describe("communityCampaignsService.closeDueCampaigns — doc §7 deadline evaluation", () => {
  it("goal reached: minimum 3, goal 6, maximum 6, six confirmed -> GOAL_REACHED, FULFILLING, supplier order created", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-1", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 6, pricePerShareMinor: 1000, currency: "GBP", supplierId: "sup-1", title: "Six shares" },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", title: "Six shares", organiser: { userId: "organiser-1" }, participants: [] } as never);
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.supplierProfile.findUnique.mockResolvedValue({ vendor: { userId: "supplier-user-1", stripeAccountId: "acct_1" } } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result).toEqual({ closed: 1, succeeded: 1, failed: 0, rescued: 0 });
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-1", status: "LIVE" }, data: expect.objectContaining({ status: "FULFILLING", fundingOutcome: "GOAL_REACHED" }) }),
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
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 } as never);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.supplierProfile.findUnique.mockResolvedValue({ vendor: { userId: "supplier-user-1", stripeAccountId: "acct_1" } } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result.succeeded).toBe(1);
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(
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
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 } as never);
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
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result).toEqual({ closed: 1, succeeded: 0, failed: 0, rescued: 1 });
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-3", status: "LIVE" }, data: expect.objectContaining({ status: "RESCUE_WINDOW" }) }),
    );
    expect(m.campaignSupplierPayment.create).not.toHaveBeenCalled();
  });

  // Reliability scenario #13 (architecture doc §18): "campaign closes while
  // payment is processing" — modeled here as two overlapping sweep runs
  // (e.g. a manual /jobs/community-buy-sweep trigger racing the daily
  // cron) both trying to close the same due campaign. The atomic claim
  // added this pass (updateMany guarded on status: "LIVE") means only one
  // can win; the loser must not re-run notifyOutcome/createSupplierOrder/
  // chargePledgesAfterSuccess for a campaign someone else is already
  // closing.
  it("scenario #13 — a campaign already claimed by a concurrent close is not processed a second time", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-race", minimumShares: 3, goalShares: 6, maximumShares: 6, confirmedShares: 6, pricePerShareMinor: 1000, currency: "GBP", supplierId: "sup-1", title: "Racing campaign" },
    ] as never);
    // Simulates: another process's updateMany already flipped this
    // campaign's status away from LIVE between the findMany read above and
    // this call — the guarded claim sees 0 rows affected.
    m.communityCampaign.updateMany.mockResolvedValue({ count: 0 } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result).toEqual({ closed: 1, succeeded: 0, failed: 0, rescued: 0 });
    expect(m.campaignSupplierPayment.create).not.toHaveBeenCalled();
    expect(m.campaignContribution.findMany).not.toHaveBeenCalled(); // chargePledgesAfterSuccess never ran
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

describe("campaignContributionsService.pledge — PLEDGE_THEN_CHARGE (client mandate 2026-09: no upfront capture)", () => {
  it("client test #1 / #12: saves the payment method reference and records a pledge — no Stripe charge is ever created", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-10", status: "LIVE", country: "GB", currency: "GBP", deadline: new Date(Date.now() + 100000), pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    } as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: "buyer-1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" } as never);
    m.campaignParticipant.upsert.mockResolvedValue({ id: "part-1" } as never);

    const txCampaign = { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-10", maximumShares: 6, confirmedShares: 0, termsLockedAt: null }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() };
    const txContribution = { create: vi.fn().mockResolvedValue({ id: "contrib-10" }) };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-10", status: "PLEDGED", participant: { userId: "buyer-1" } } as never);

    const result = await campaignContributionsService.pledge("buyer-1", "camp-10", 1, "pm-1");

    expect(result.status).toBe("PLEDGED");
    expect(txContribution.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PLEDGED", paymentMethodId: "pm-1", amount: 1000 }) }),
    );
    // The whole point of this model: nothing is captured at pledge time.
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("refuses to pledge when the market has not enabled Community Buy payments", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-10", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GB", currency: "GBP", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: false,
    } as never);

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-10", 1, "pm-1"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("blocks a market still on the old PAY_NOW_REFUND_ON_FAILURE mode — the client explicitly rejected that model", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-10b", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GB", currency: "GBP", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PAY_NOW_REFUND_ON_FAILURE",
    } as never);

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-10b", 1, "pm-1"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a pledge in a currency Stripe doesn't support, instead of silently charging EUR for the same numeric amount", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-11", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GH", currency: "GHS", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GH", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    } as never);

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-11", 1, "pm-1"),
    ).rejects.toMatchObject({ statusCode: 400, code: "CURRENCY_NOT_SUPPORTED" });
    expect(m.campaignContribution.create).not.toHaveBeenCalled();
  });

  it("rejects a quantity that would exceed the campaign's remaining capacity", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-12", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GB", currency: "GBP", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 5,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    } as never);

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-12", 2, "pm-1"),
    ).rejects.toMatchObject({ statusCode: 409, code: "CAPACITY_UNAVAILABLE" });
    expect(m.buyerPaymentMethod.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a payment method that doesn't belong to this buyer", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-12b", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GB", currency: "GBP", pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    } as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-2", buyerId: "someone-else" } as never);

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-12b", 1, "pm-2"),
    ).rejects.toMatchObject({ statusCode: 404, code: "PAYMENT_METHOD_NOT_FOUND" });
  });
});

describe("campaignContributionsService.pledgeOrganiserTopUp", () => {
  it("rejects a top-up when the campaign isn't in its rescue window", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-13", organiserId: "org-1", status: "LIVE" } as never);

    await expect(campaignContributionsService.pledgeOrganiserTopUp("organiser-user-1", "camp-13", 1, "pm-1")).rejects.toMatchObject({ statusCode: 409 });
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

describe("campaignContributionsService.attemptCharge — the only place a pledge is ever charged (client mandate 2026-09)", () => {
  it("client test #3/#4: charges the saved card off-session and posts the escrow ledger entry when Stripe confirms success", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({
      id: "contrib-30", campaignId: "camp-20", quantity: 2, status: "PLEDGED", currency: "GBP", amount: 2000,
      participant: { userId: "buyer-1" },
      paymentMethod: { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" },
    } as never);
    m.campaignContribution.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.campaignChargeAttempt.count.mockResolvedValueOnce(0 as never);
    m.campaignChargeAttempt.create.mockResolvedValueOnce({ id: "attempt-1" } as never);
    vi.mocked(stripe.paymentIntents.create).mockResolvedValueOnce({ id: "pi_success_1", status: "succeeded" } as never);

    const ledgerAccount = { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "acct-1" }) };
    const ledgerEntry = { create: vi.fn().mockResolvedValue({ id: "entry-1" }) };
    const txContribution = { update: vi.fn() };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ campaignContribution: txContribution, ledgerAccount, ledgerEntry }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-30", status: "PAID" } as never);

    const result = await campaignContributionsService.attemptCharge("contrib-30");

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2000, currency: "gbp", customer: "cus_1", payment_method: "pm_1", off_session: true, confirm: true }),
      { idempotencyKey: "contrib-30:1" },
    );
    expect(result.status).toBe("PAID");
    expect(ledgerEntry.create).toHaveBeenCalledTimes(2);
    const legs = ledgerEntry.create.mock.calls.map((c: any) => c[0].data);
    expect(legs.find((l: any) => l.direction === "DEBIT")?.amount).toBe(2000);
    expect(legs.find((l: any) => l.direction === "CREDIT")?.amount).toBe(2000);
  });

  it("client test #6: charging an already-PAID contribution again is a no-op — never double-charges", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-31", status: "PAID", participant: { userId: "buyer-1" } } as never);

    const result = await campaignContributionsService.attemptCharge("contrib-31");

    expect(result.status).toBe("PAID");
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("client test #5: a declined charge with attempts remaining moves to CHARGE_FAILED (retryable), not a terminal state", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({
      id: "contrib-32", campaignId: "camp-21", quantity: 1, status: "PLEDGED", currency: "GBP", amount: 1000,
      participant: { userId: "buyer-2" },
      paymentMethod: { stripeCustomerId: "cus_2", stripePaymentMethodId: "pm_2" },
    } as never);
    m.campaignContribution.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.campaignChargeAttempt.count.mockResolvedValueOnce(0 as never);
    m.campaignChargeAttempt.create.mockResolvedValueOnce({ id: "attempt-2" } as never);
    vi.mocked(stripe.paymentIntents.create).mockRejectedValueOnce(Object.assign(new Error("Your card was declined."), { code: "card_declined" }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-32", status: "CHARGE_FAILED" } as never);

    const result = await campaignContributionsService.attemptCharge("contrib-32");

    expect(result.status).toBe("CHARGE_FAILED");
    expect(m.campaignContribution.update).toHaveBeenCalledWith({ where: { id: "contrib-32" }, data: { status: "CHARGE_FAILED" } });
  });

  it("client test #5: after MAX_CHARGE_ATTEMPTS (3) prior attempts, refuses to try again and marks the pledge terminally failed", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({
      id: "contrib-33", campaignId: "camp-22", status: "CHARGE_FAILED",
      participant: { userId: "buyer-3" },
      paymentMethod: { stripeCustomerId: "cus_3", stripePaymentMethodId: "pm_3" },
    } as never);
    m.campaignContribution.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.campaignChargeAttempt.count.mockResolvedValueOnce(3 as never);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-33", status: "CHARGE_FAILED" } as never);

    const result = await campaignContributionsService.attemptCharge("contrib-33");

    expect(result.status).toBe("CHARGE_FAILED");
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(m.campaignChargeAttempt.create).not.toHaveBeenCalled();
  });

  it("client test #9: no saved payment method at campaign end -> terminal failure without ever calling Stripe", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({
      id: "contrib-34", campaignId: "camp-23", status: "PLEDGED",
      participant: { userId: "buyer-4" },
      paymentMethod: null,
    } as never);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-34", status: "CHARGE_FAILED" } as never);

    const result = await campaignContributionsService.attemptCharge("contrib-34");

    expect(result.status).toBe("CHARGE_FAILED");
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("client test #8: a contribution mid-charge (PAYMENT_PROCESSING) is not PLEDGED or CHARGE_FAILED, so a second concurrent attempt is rejected rather than double-firing", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-35", status: "PAYMENT_PROCESSING", participant: { userId: "buyer-5" } } as never);

    await expect(campaignContributionsService.attemptCharge("contrib-35")).rejects.toMatchObject({ statusCode: 409 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  // ─── Reliability scenario #4 (architecture doc §18): "payment remains processing" ──

  it("scenario #4 — a Stripe \"processing\" outcome leaves the attempt PENDING, never FAILED, for a delayed-notification payment method still in flight", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({
      id: "contrib-36", campaignId: "camp-24", quantity: 1, status: "PLEDGED", currency: "GBP", amount: 1500,
      participant: { userId: "buyer-6" },
      paymentMethod: { stripeCustomerId: "cus_6", stripePaymentMethodId: "pm_6" },
    } as never);
    m.campaignContribution.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.campaignChargeAttempt.count.mockResolvedValueOnce(0 as never);
    m.campaignChargeAttempt.create.mockResolvedValueOnce({ id: "attempt-36" } as never);
    vi.mocked(stripe.paymentIntents.create).mockResolvedValueOnce({ id: "pi_processing_36", status: "processing" } as never);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-36", status: "PAYMENT_PROCESSING" } as never);

    const result = await campaignContributionsService.attemptCharge("contrib-36");

    expect(result.status).toBe("PAYMENT_PROCESSING");
    expect(m.campaignChargeAttempt.update).toHaveBeenCalledWith({
      where: { id: "attempt-36" },
      data: { stripePaymentIntentId: "pi_processing_36" },
    });
    expect(m.campaignContribution.update).not.toHaveBeenCalled();
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });

  it("scenario #4 — blocks a second attempt while still processing, so a retry can never reach Stripe with a new idempotency key", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-36b", status: "PAYMENT_PROCESSING", participant: { userId: "buyer-6" } } as never);

    await expect(campaignContributionsService.attemptCharge("contrib-36b")).rejects.toMatchObject({ statusCode: 409 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

// ─── Reliability scenario #5 (architecture doc §18): "payment succeeds after the app shows pending" ──

describe("campaignContributionsService.resolveProcessingCharge — reliability scenario #5", () => {
  it("posts the escrow ledger entry and marks the pledge PAID exactly once when the webhook later confirms success", async () => {
    m.campaignChargeAttempt.findFirst.mockResolvedValueOnce({ id: "attempt-5", status: "PENDING" } as never);
    m.campaignContribution.findUnique.mockResolvedValueOnce({
      id: "contrib-5", status: "PAYMENT_PROCESSING", campaignId: "camp-25", currency: "GBP", amount: 1000,
      participant: { userId: "buyer-5" },
    } as never);
    m.campaignChargeAttempt.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    const ledgerAccount = { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "acct-5" }) };
    const ledgerEntry = { create: vi.fn().mockResolvedValue({ id: "entry-5" }) };
    const txContribution = { update: vi.fn() };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ campaignContribution: txContribution, ledgerAccount, ledgerEntry }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({ id: "contrib-5", status: "PAID" } as never);

    const result = await campaignContributionsService.resolveProcessingCharge("contrib-5", "pi_proc_5", true);

    expect(result.handled).toBe(true);
    expect(m.campaignChargeAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "attempt-5", status: "PENDING" }, data: { status: "SUCCEEDED" } }),
    );
    expect(txContribution.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "contrib-5" }, data: expect.objectContaining({ status: "PAID", stripePaymentIntentId: "pi_proc_5" }) }),
    );
    expect(ledgerEntry.create).toHaveBeenCalledTimes(2); // escrow debit + credit, posted exactly once
  });

  it("is idempotent — a concurrent duplicate resolution that loses the atomic claim never posts the ledger entry a second time", async () => {
    m.campaignChargeAttempt.findFirst.mockResolvedValueOnce({ id: "attempt-5b", status: "PENDING" } as never);
    m.campaignContribution.findUnique.mockResolvedValueOnce({
      id: "contrib-5b", status: "PAYMENT_PROCESSING", campaignId: "camp-25", currency: "GBP", amount: 1000,
      participant: { userId: "buyer-5b" },
    } as never);
    m.campaignChargeAttempt.updateMany.mockResolvedValueOnce({ count: 0 } as never); // someone else already won

    const result = await campaignContributionsService.resolveProcessingCharge("contrib-5b", "pi_proc_5b", true);

    expect(result.handled).toBe(false);
    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("is a no-op once the attempt is already resolved — a genuinely duplicate webhook cannot re-run the outcome", async () => {
    m.campaignChargeAttempt.findFirst.mockResolvedValueOnce({ id: "attempt-5c", status: "SUCCEEDED" } as never);

    const result = await campaignContributionsService.resolveProcessingCharge("contrib-5c", "pi_proc_5c", true);

    expect(result.handled).toBe(false);
    expect(m.campaignChargeAttempt.updateMany).not.toHaveBeenCalled();
    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("moves the pledge to CHARGE_FAILED (retryable) when the delayed payment ultimately fails", async () => {
    m.campaignChargeAttempt.findFirst.mockResolvedValueOnce({ id: "attempt-5d", status: "PENDING" } as never);
    m.campaignContribution.findUnique.mockResolvedValueOnce({
      id: "contrib-5d", status: "PAYMENT_PROCESSING", campaignId: "camp-25",
      participant: { userId: "buyer-5d" },
    } as never);
    m.campaignChargeAttempt.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.campaignChargeAttempt.count.mockResolvedValueOnce(1 as never);

    const result = await campaignContributionsService.resolveProcessingCharge("contrib-5d", "pi_proc_5d", false, "Bank debit failed");

    expect(result.handled).toBe(true);
    expect(m.campaignContribution.update).toHaveBeenCalledWith({ where: { id: "contrib-5d" }, data: { status: "CHARGE_FAILED" } });
  });
});

describe("campaignContributionsService.chargeAllPledgesForCampaign — client test #10: each contribution handled independently", () => {
  it("charges every pledge independently — one succeeding and one failing don't affect each other — then syncs the supplier payment total", async () => {
    m.campaignContribution.findMany.mockResolvedValueOnce([
      { id: "contrib-40" }, { id: "contrib-41" },
    ] as never);

    // contrib-40 succeeds
    m.campaignContribution.findUniqueOrThrow
      .mockResolvedValueOnce({
        id: "contrib-40", campaignId: "camp-30", quantity: 1, status: "PLEDGED", currency: "GBP", amount: 1000,
        participant: { userId: "buyer-a" }, paymentMethod: { stripeCustomerId: "cus_a", stripePaymentMethodId: "pm_a" },
      } as never)
      .mockResolvedValueOnce({ id: "contrib-40", status: "PAID" } as never)
      // contrib-41 fails (no payment method)
      .mockResolvedValueOnce({
        id: "contrib-41", campaignId: "camp-30", status: "PLEDGED",
        participant: { userId: "buyer-b" }, paymentMethod: null,
      } as never)
      .mockResolvedValueOnce({ id: "contrib-41", status: "CHARGE_FAILED" } as never);

    m.campaignContribution.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.campaignChargeAttempt.count.mockResolvedValueOnce(0 as never);
    m.campaignChargeAttempt.create.mockResolvedValueOnce({ id: "attempt-40" } as never);
    vi.mocked(stripe.paymentIntents.create).mockResolvedValueOnce({ id: "pi_40", status: "succeeded" } as never);
    const ledgerAccount = { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "acct-1" }) };
    const ledgerEntry = { create: vi.fn().mockResolvedValue({ id: "entry-1" }) };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ campaignContribution: { update: vi.fn() }, ledgerAccount, ledgerEntry }));

    m.campaignSupplierPayment.findUnique.mockResolvedValueOnce({ campaignId: "camp-30" } as never);
    m.campaignContribution.aggregate.mockResolvedValueOnce({ _sum: { amount: 1000 } } as never);

    const result = await campaignContributionsService.chargeAllPledgesForCampaign("camp-30");

    expect(result).toEqual({ total: 2, charged: 1, failed: 1 });
    expect(m.campaignSupplierPayment.update).toHaveBeenCalledWith({ where: { campaignId: "camp-30" }, data: { amount: 1000 } });
  });

  it("client test #2/#11: a campaign that never reaches this point (never charged) has no PAID contributions — never invents a refund", async () => {
    // createRefundRecordsForFailedCampaign only ever looks at status: PAID.
    m.campaignContribution.findMany.mockResolvedValueOnce([]); // no PAID contributions exist for a pledge-only failed campaign
    const created = await communityCampaignsService.createRefundRecordsForFailedCampaign("camp-31");
    expect(created).toBe(0);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe("campaignContributionsService.retryCharge", () => {
  it("rejects a retry on a pledge that isn't CHARGE_FAILED", async () => {
    m.campaignContribution.findUnique.mockResolvedValueOnce({ id: "contrib-50", status: "PLEDGED", participant: { userId: "buyer-6" } } as never);
    await expect(campaignContributionsService.retryCharge("buyer-6", "contrib-50")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a retry from someone who isn't the pledge's own participant", async () => {
    m.campaignContribution.findUnique.mockResolvedValueOnce({ id: "contrib-51", status: "CHARGE_FAILED", participant: { userId: "buyer-7" } } as never);
    await expect(campaignContributionsService.retryCharge("someone-else", "contrib-51")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("campaignContributionsService.releaseSupplierPayment — owner settlement + Eki processing fee (client mandate 2026-09)", () => {
  it("client test #4: transfers the collected total minus the configured fee to the supplier's Stripe account, and posts a balanced 3-leg ledger entry", async () => {
    m.campaignSupplierPayment.findUnique.mockResolvedValueOnce({
      id: "payment-1", campaignId: "camp-40", currency: "GBP", status: "NOT_RELEASED", payoutStripeAccountIdAtApproval: null,
      campaign: { country: "GB", supplier: { vendor: { id: "vendor-1", stripeAccountId: "acct_1", stripePayoutsEnabled: true } } },
    } as never);
    m.campaignContribution.aggregate.mockResolvedValueOnce({ _sum: { amount: 10000 } } as never); // 100.00 collected
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyFeeBps: 500 } as never); // 5%
    vi.mocked(stripe.transfers.create).mockResolvedValueOnce({ id: "tr_1" } as never);
    m.campaignSupplierPayment.update.mockResolvedValue({ id: "payment-1", status: "PAID" } as never);

    await campaignContributionsService.releaseSupplierPayment("admin-1", "camp-40");

    expect(stripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9500, currency: "gbp", destination: "acct_1" }),
      { idempotencyKey: "community-buy-transfer:camp-40" },
    );
    expect(m.campaignSupplierPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAID", stripeTransferId: "tr_1" }) }),
    );
    // Real ledger posting: which account TYPE each leg touched, and the
    // amount/direction on each entry — a balanced 3-leg entry for the
    // Eki processing fee split (escrow debit = vendor credit + fee credit).
    const accountTypesTouched = m.ledgerAccount.create.mock.calls.map((c: any) => c[0].data.type);
    expect(accountTypesTouched).toEqual(expect.arrayContaining(["COMMUNITY_BUY_ESCROW", "VENDOR_PAYABLE", "PLATFORM_FEE_REVENUE"]));
    const entries = m.ledgerEntry.create.mock.calls.map((c: any) => c[0].data);
    expect(entries).toHaveLength(3);
    expect(entries.filter((e: any) => e.direction === "DEBIT").reduce((s: number, e: any) => s + e.amount, 0)).toBe(10000);
    expect(entries.filter((e: any) => e.direction === "CREDIT").reduce((s: number, e: any) => s + e.amount, 0)).toBe(10000);
    expect(entries.some((e: any) => e.amount === 9500)).toBe(true); // vendor net
    expect(entries.some((e: any) => e.amount === 500)).toBe(true); // Eki fee
  });

  it("refuses to release when the market has no configured processing fee — never invents a default percentage", async () => {
    m.campaignSupplierPayment.findUnique.mockResolvedValueOnce({
      id: "payment-2", campaignId: "camp-41", currency: "GBP", status: "NOT_RELEASED", payoutStripeAccountIdAtApproval: null,
      campaign: { country: "GB", supplier: { vendor: { id: "vendor-2", stripeAccountId: "acct_2", stripePayoutsEnabled: true } } },
    } as never);
    m.campaignContribution.aggregate.mockResolvedValueOnce({ _sum: { amount: 5000 } } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyFeeBps: null } as never);

    await expect(campaignContributionsService.releaseSupplierPayment("admin-1", "camp-41")).rejects.toMatchObject({ statusCode: 409, code: "FEE_NOT_CONFIGURED" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("refuses to release when nothing has actually been charged yet — never transfers money Eki never collected", async () => {
    m.campaignSupplierPayment.findUnique.mockResolvedValueOnce({
      id: "payment-3", campaignId: "camp-42", currency: "GBP", status: "NOT_RELEASED", payoutStripeAccountIdAtApproval: null,
      campaign: { country: "GB", supplier: { vendor: { id: "vendor-3", stripeAccountId: "acct_3", stripePayoutsEnabled: true } } },
    } as never);
    m.campaignContribution.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } } as never);

    await expect(campaignContributionsService.releaseSupplierPayment("admin-1", "camp-42")).rejects.toMatchObject({ statusCode: 409, code: "NOTHING_COLLECTED_YET" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("refuses to release when the supplier's payout account isn't ready", async () => {
    m.campaignSupplierPayment.findUnique.mockResolvedValueOnce({
      id: "payment-4", campaignId: "camp-43", currency: "GBP", status: "NOT_RELEASED", payoutStripeAccountIdAtApproval: null,
      campaign: { country: "GB", supplier: { vendor: { id: "vendor-4", stripeAccountId: null, stripePayoutsEnabled: false } } },
    } as never);

    await expect(campaignContributionsService.releaseSupplierPayment("admin-1", "camp-43")).rejects.toMatchObject({ statusCode: 409, code: "PAYOUTS_NOT_ENABLED" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("is idempotent — releasing an already-PAID payment returns it unchanged without transferring again", async () => {
    m.campaignSupplierPayment.findUnique.mockResolvedValueOnce({ id: "payment-5", campaignId: "camp-44", status: "PAID" } as never);
    const result = await campaignContributionsService.releaseSupplierPayment("admin-1", "camp-44");
    expect(result.status).toBe("PAID");
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  // Reliability scenario #20 (architecture doc §18): "supplier payment fails".
  it("scenario #20 — a failed Stripe transfer puts the payment ON_HOLD with the real failure reason, never silently PAID", async () => {
    m.campaignSupplierPayment.findUnique.mockResolvedValueOnce({
      id: "payment-6", campaignId: "camp-45", currency: "GBP", status: "NOT_RELEASED", payoutStripeAccountIdAtApproval: null,
      campaign: { country: "GB", supplier: { vendor: { id: "vendor-6", stripeAccountId: "acct_6", stripePayoutsEnabled: true } } },
    } as never);
    m.campaignContribution.aggregate.mockResolvedValueOnce({ _sum: { amount: 10000 } } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyFeeBps: 500 } as never);
    vi.mocked(stripe.transfers.create).mockRejectedValueOnce(new Error("Your Stripe account's balance is insufficient for this transfer."));

    await expect(campaignContributionsService.releaseSupplierPayment("admin-1", "camp-45")).rejects.toMatchObject({ statusCode: 502 });

    expect(m.campaignSupplierPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { campaignId: "camp-45" },
        data: expect.objectContaining({ status: "ON_HOLD", holdReason: expect.stringContaining("insufficient") }),
      }),
    );
    // Never marked PAID, never posted a ledger entry for money that never actually moved.
    expect(m.campaignSupplierPayment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) }),
    );
    expect(m.ledgerEntry.create).not.toHaveBeenCalled();
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

  // Client mandate: "if a market has no explicit approved payment mode,
  // disable Community Buy payment there." Only PAY_NOW_REFUND_ON_FAILURE
  // is actually implemented — everything else must stay blocked too.
  it("blocks payments when both flags are on but no payment mode is set (null) — the flags alone are not an approval", async () => {
    m.marketConfiguration.count.mockResolvedValue(1);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: null,
    } as never);

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("GB")).toBe(false);
  });

  it("blocks payments when the mode is set to an unimplemented mode (AUTHORISE_THEN_CAPTURE) — never silently routed through the wrong flow", async () => {
    m.marketConfiguration.count.mockResolvedValue(1);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "AUTHORISE_THEN_CAPTURE",
    } as never);

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("GB")).toBe(false);
  });

  it("blocks payments when the mode is still the old PAY_NOW_REFUND_ON_FAILURE — client mandate 2026-09 explicitly rejected that model", async () => {
    m.marketConfiguration.count.mockResolvedValue(1);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PAY_NOW_REFUND_ON_FAILURE",
    } as never);

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("GB")).toBe(false);
  });

  it("allows payments only when the mode is explicitly PLEDGE_THEN_CHARGE — the one mode that's actually implemented", async () => {
    m.marketConfiguration.count.mockResolvedValue(1);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    } as never);

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("GB")).toBe(true);
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

  // Reliability scenario #25 (architecture doc §18): "campaign state and
  // financial total disagree". The campaign's operational status is never
  // trusted as financial truth by itself — netPosition is independently
  // recomputed from the real contribution/refund/payout rows every time,
  // so a genuine mismatch (e.g. a campaign marked COMPLETED with money
  // still unaccounted for) is visible here rather than hidden behind a
  // status label that says everything is fine.
  it("scenario #25 — netPosition surfaces a real financial shortfall even when the campaign's own status claims it's COMPLETED", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-mismatch", title: "Mismatch campaign", currency: "GBP", status: "COMPLETED", fundingOutcome: "GOAL_REACHED",
    } as never);
    m.campaignContribution.findMany.mockResolvedValue([
      { id: "contrib-x", amount: 10000, quantity: 5, isOrganiserTopUp: false, updatedAt: new Date("2026-01-01T00:00:00Z"), participant: { user: { name: "Buyer X" } } },
    ] as never);
    m.campaignRefund.findMany.mockResolvedValue([]);
    // Supplier payment record exists but was never actually released (still
    // NOT_RELEASED) — a real scenario where "COMPLETED" doesn't match the
    // real money movement.
    m.campaignSupplierPayment.findUnique.mockResolvedValue({ id: "sp-1", status: "NOT_RELEASED", amount: 10000, updatedAt: new Date() } as never);

    const ledger = await campaignContributionsService.getCampaignLedger("camp-mismatch");

    // The supplier leg is correctly excluded (never PAID), so netPosition
    // shows the full 10000 still sitting uncollected-by-supplier — a real,
    // computed discrepancy signal an admin can act on, not a status label.
    expect(ledger.totals.totalPaidToSupplier).toBe(0);
    expect(ledger.totals.netPosition).toBe(10000);
    expect(ledger.campaign.status).toBe("COMPLETED");
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
