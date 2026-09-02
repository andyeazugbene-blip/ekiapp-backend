import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    campaignContribution: { findMany: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
    campaignRefund: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    campaignParticipant: { findMany: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn(), upsert: vi.fn() },
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

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("communityCampaignsService.closeDueCampaigns", () => {
  it("marks a campaign SUCCEEDED only when reconciled PAID contributions meet the target — not from a stored/claimed total", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      {
        id: "camp-1",
        targetAmount: 10000,
        // Two PAID contributions reconciled directly from the DB, summing
        // to exactly the target — this is the only thing that may decide
        // success, per spec §8.7/§22.
        contributions: [{ amount: 6000 }, { amount: 4000 }],
      },
    ] as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result).toEqual({ closed: 1, succeeded: 1, failed: 0 });
    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-1" }, data: expect.objectContaining({ status: "SUCCEEDED", paidTotal: 10000 }) }),
    );
    // notifyOutcome does its own lookups — not exercised here to keep this
    // test focused on the success/failure decision itself.
  });

  it("marks a campaign FAILED but does NOT auto-refund — the organiser hasn't decided yet, and the client hasn't confirmed what fulfil-anyway means financially", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-2", targetAmount: 10000, contributions: [{ amount: 3000 }] },
    ] as never);
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-2", title: "Failed campaign", organiser: { userId: "organiser-1" }, supplier: {}, participants: [],
    } as never);

    const result = await communityCampaignsService.closeDueCampaigns();

    expect(result).toEqual({ closed: 1, succeeded: 0, failed: 1 });
    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-2" }, data: expect.objectContaining({ status: "FAILED", paidTotal: 3000 }) }),
    );
    // Closing a campaign must never itself move money or create refund
    // records — only an explicit organiser decision (cancelAfterFailure) does.
    expect(m.campaignRefund.create).not.toHaveBeenCalled();
  });

  it("does not create a duplicate refund record if one already exists (unique constraint)", async () => {
    m.campaignContribution.findMany.mockResolvedValue([{ id: "contrib-2", amount: 500, currency: "GBP" }] as never);
    m.campaignRefund.create.mockRejectedValue({ code: "P2002" });

    const created = await communityCampaignsService.createRefundRecordsForFailedCampaign("camp-3");

    expect(created).toBe(0);
    expect(m.campaignContribution.update).not.toHaveBeenCalled();
  });
});

describe("communityCampaignsService.fulfilAnyway / cancelAfterFailure", () => {
  it("fulfilAnyway moves FAILED to FULFILLING and takes no financial action", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-5", organiserId: "org-1", status: "FAILED", title: "Missed target campaign",
    } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-5", status: "FULFILLING" } as never);
    m.campaignParticipant.findMany.mockResolvedValue([]);

    const result = await communityCampaignsService.fulfilAnyway("organiser-user-1", "camp-5");

    expect(result.status).toBe("FULFILLING");
    expect(m.communityCampaign.update).toHaveBeenCalledWith({ where: { id: "camp-5" }, data: { status: "FULFILLING" } });
    expect(m.campaignRefund.create).not.toHaveBeenCalled();
  });

  it("fulfilAnyway rejects a campaign that isn't FAILED", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-6", organiserId: "org-1", status: "LIVE" } as never);

    await expect(communityCampaignsService.fulfilAnyway("organiser-user-1", "camp-6")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("cancelAfterFailure moves FAILED to CANCELLED and reuses the existing refund-record path", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-7", organiserId: "org-1", status: "FAILED", title: "Missed target campaign",
    } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-7", status: "CANCELLED" } as never);
    m.campaignContribution.findMany.mockResolvedValue([{ id: "contrib-9", amount: 1200, currency: "GBP" }] as never);
    m.campaignRefund.create.mockResolvedValue({ id: "refund-9" } as never);
    m.campaignParticipant.findMany.mockResolvedValue([{ userId: "participant-1" }] as never);

    const result = await communityCampaignsService.cancelAfterFailure("organiser-user-1", "camp-7");

    expect(result.status).toBe("CANCELLED");
    expect(m.campaignRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contributionId: "contrib-9", idempotencyKey: "refund:contrib-9" }) }),
    );
  });
});

describe("campaignContributionsService.createContributionIntent", () => {
  it("refuses to start a payment when the market has not enabled Community Buy payments", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-4", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GB", currency: "GBP",
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: false,
    } as never);

    await expect(
      campaignContributionsService.createContributionIntent("buyer-1", "camp-4", 1000),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("rejects a contribution in a currency Stripe doesn't support, instead of silently charging EUR for the same numeric amount", async () => {
    // GHS is not in Stripe's supported currency list — resolveStripeCurrency()
    // would otherwise fall back to "eur" while keeping the same integer
    // amount, i.e. charging 1000.00 EUR for a 1000.00 GHS contribution.
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-5", status: "LIVE", deadline: new Date(Date.now() + 100000), country: "GH", currency: "GHS",
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GH", communityBuyEnabled: true, communityBuyPaymentsEnabled: true,
    } as never);

    await expect(
      campaignContributionsService.createContributionIntent("buyer-1", "camp-5", 1000),
    ).rejects.toMatchObject({ statusCode: 400, code: "CURRENCY_NOT_SUPPORTED" });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(m.campaignContribution.create).not.toHaveBeenCalled();
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
