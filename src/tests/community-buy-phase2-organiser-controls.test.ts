/**
 * Phase 2 (organiser controls) — focused tests for the six additive
 * changes: per-buyer min/max slot limits, scheduled campaign opening,
 * organiser-facing pause/resume, organiser general change-request,
 * organiser identity display preference, and the admin unified issue
 * notes field. Mirrors the existing Prisma-mocked unit-test convention
 * used throughout this test suite (see community-buy.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn() },
    organiserProfile: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    campaignParticipant: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    campaignContribution: { aggregate: vi.fn() },
    buyerPaymentMethod: { findUnique: vi.fn() },
    communityBuySupportCase: { create: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { trigger: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";
import { organiserSupplierService } from "../modules/community-buy/organiser-supplier.service";
import { supportCaseService } from "../modules/community-buy/support-case.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.marketConfiguration.count.mockResolvedValue(1);
});

const baseCampaign = {
  id: "camp-1",
  organiserId: "org-1",
  country: "GB",
  currency: "GBP",
  status: "DRAFT",
  minimumShares: 5,
  goalShares: 10,
  maximumShares: 20,
  perBuyerMinShares: null,
  perBuyerMaxShares: null,
  pricePerShareMinor: 1000,
  quantityPerOrder: 1,
  unit: "kg",
  deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  termsLockedAt: null,
  confirmedShares: 0,
  scheduledOpenAt: null,
  wholesaleAmountMinor: null,
};

describe("Per-buyer min/max slot limits — validation (create/update)", () => {
  it("rejects a per-buyer maximum below the per-buyer minimum", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });

    await expect(
      communityCampaignsService.create("u1", { title: "Rice buy", country: "GB", perBuyerMinShares: 5, perBuyerMaxShares: 2 } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a per-buyer maximum greater than the campaign's total maximum shares", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });

    await expect(
      communityCampaignsService.create("u1", { title: "Rice buy", country: "GB", maximumShares: 10, perBuyerMaxShares: 15 } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("accepts and persists valid per-buyer limits on create", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });
    m.communityCampaign.create.mockResolvedValue({ ...baseCampaign, perBuyerMinShares: 1, perBuyerMaxShares: 5 });

    await communityCampaignsService.create("u1", { title: "Rice buy", country: "GB", maximumShares: 20, perBuyerMinShares: 1, perBuyerMaxShares: 5 } as never);

    expect(m.communityCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ perBuyerMinShares: 1, perBuyerMaxShares: 5 }) }),
    );
  });

  it("update() rejects raising per-buyer max above the campaign's EXISTING maximumShares when maximumShares isn't itself being changed", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "DRAFT" });

    await expect(
      communityCampaignsService.update("u1", "camp-1", { perBuyerMaxShares: 999 } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("locks per-buyer limits once termsLockedAt is set, same as maximumShares", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "DRAFT", termsLockedAt: new Date() });

    await expect(
      communityCampaignsService.update("u1", "camp-1", { perBuyerMaxShares: 5 } as never),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("Per-buyer min/max slot limits — enforcement in pledge()", () => {
  it("rejects a pledge below the campaign's per-buyer minimum", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", perBuyerMinShares: 3 });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE" });

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-1", 2, "pm_1"),
    ).rejects.toMatchObject({ code: "PER_BUYER_MINIMUM_NOT_MET" });
  });

  it("rejects a pledge that would push a buyer's cumulative total over the per-buyer maximum", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", perBuyerMaxShares: 5 });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE" });
    m.campaignParticipant.findFirst.mockResolvedValue({ id: "part-1" });
    m.campaignContribution.aggregate.mockResolvedValue({ _sum: { quantity: 4 } });

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-1", 2, "pm_1"),
    ).rejects.toMatchObject({ code: "PER_BUYER_LIMIT_EXCEEDED" });
  });

  it("a pledge within both per-buyer bounds passes the per-buyer check and proceeds to the next validation step", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", perBuyerMinShares: 1, perBuyerMaxShares: 5 });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE" });
    m.campaignParticipant.findFirst.mockResolvedValue(null);
    // No saved payment method — proves the per-buyer check passed (didn't
    // throw) and control reached requirePaymentMethod(), the next gate.
    m.buyerPaymentMethod.findUnique.mockResolvedValue(null);

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-1", 3, "pm_1"),
    ).rejects.toMatchObject({ code: "PAYMENT_METHOD_NOT_FOUND" });
  });

  it("a campaign with no per-buyer limits set never queries the participant's existing total", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE" });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE" });
    m.buyerPaymentMethod.findUnique.mockResolvedValue(null);

    await expect(campaignContributionsService.pledge("buyer-1", "camp-1", 5, "pm_1")).rejects.toMatchObject({ code: "PAYMENT_METHOD_NOT_FOUND" });
    expect(m.campaignParticipant.findFirst).not.toHaveBeenCalled();
  });
});

describe("Scheduled campaign opening", () => {
  it("create() rejects a scheduledOpenAt in the past", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });

    await expect(
      communityCampaignsService.create("u1", { title: "Rice buy", country: "GB", scheduledOpenAt: new Date(Date.now() - 1000).toISOString() } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("create() rejects a scheduledOpenAt on or after the campaign's own deadline", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });
    const deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    await expect(
      communityCampaignsService.create("u1", {
        title: "Rice buy",
        country: "GB",
        deadline: deadline.toISOString(),
        scheduledOpenAt: new Date(deadline.getTime() + 1000).toISOString(),
      } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("publish() with a future scheduledOpenAt records publishedAt but leaves status APPROVED", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign, organiserId: "org-1", status: "APPROVED", scheduledOpenAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true });
    m.communityCampaign.update.mockResolvedValue({ ...baseCampaign, status: "APPROVED" });

    await communityCampaignsService.publish("u1", "camp-1");

    expect(m.communityCampaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { publishedAt: expect.any(Date) },
    });
  });

  it("publish() with no scheduledOpenAt goes LIVE immediately — unchanged regression behavior", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "APPROVED", scheduledOpenAt: null });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true });
    m.communityCampaign.update.mockResolvedValue({ ...baseCampaign, status: "LIVE" });

    await communityCampaignsService.publish("u1", "camp-1");

    expect(m.communityCampaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { status: "LIVE", publishedAt: expect.any(Date) },
    });
  });

  it("publish() with an ALREADY-PASSED scheduledOpenAt also goes LIVE immediately", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "APPROVED", scheduledOpenAt: new Date(Date.now() - 1000) });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true });
    m.communityCampaign.update.mockResolvedValue({ ...baseCampaign, status: "LIVE" });

    await communityCampaignsService.publish("u1", "camp-1");

    expect(m.communityCampaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { status: "LIVE", publishedAt: expect.any(Date) },
    });
  });

  it("openScheduledCampaigns() promotes a due, published, APPROVED campaign to LIVE and notifies the organiser", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-1", title: "Rice buy", organiser: { userId: "org-user-1" } },
    ]);
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 });

    const result = await communityCampaignsService.openScheduledCampaigns();

    expect(result.opened).toBe(1);
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith({ where: { id: "camp-1", status: "APPROVED" }, data: { status: "LIVE" } });
  });

  it("openScheduledCampaigns() never double-fires under an overlapping-sweep race — the loser's guarded claim returns count 0", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { id: "camp-1", title: "Rice buy", organiser: { userId: "org-user-1" } },
    ]);
    // Simulates another concurrent sweep run having already claimed it.
    m.communityCampaign.updateMany.mockResolvedValue({ count: 0 });

    const result = await communityCampaignsService.openScheduledCampaigns();

    expect(result.opened).toBe(0);
  });

  it("openScheduledCampaigns() only ever queries APPROVED + published + due campaigns", async () => {
    m.communityCampaign.findMany.mockResolvedValue([]);

    await communityCampaignsService.openScheduledCampaigns();

    expect(m.communityCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "APPROVED", publishedAt: { not: null }, scheduledOpenAt: { lte: expect.any(Date) } } }),
    );
  });
});

describe("Organiser-facing pause/resume", () => {
  it("pauseByOrganiser() rejects a non-owner", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "someone-else", status: "LIVE" });

    await expect(communityCampaignsService.pauseByOrganiser("u1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("pauseByOrganiser() rejects a campaign that isn't LIVE", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "DRAFT" });

    await expect(communityCampaignsService.pauseByOrganiser("u1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("pauseByOrganiser() pauses a live campaign owned by the caller and notifies every participant", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "LIVE" });
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 });
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue({ ...baseCampaign, status: "PAUSED" });
    m.campaignParticipant.findMany.mockResolvedValue([{ userId: "buyer-1" }, { userId: "buyer-2" }]);

    const result = await communityCampaignsService.pauseByOrganiser("u1", "camp-1");

    expect(result.status).toBe("PAUSED");
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith({ where: { id: "camp-1", status: "LIVE" }, data: { status: "PAUSED" } });
  });

  it("Phase 8 — pauseByOrganiser() loses the race when the success sweep already moved this campaign off LIVE", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "LIVE" });
    m.communityCampaign.updateMany.mockResolvedValue({ count: 0 });

    await expect(communityCampaignsService.pauseByOrganiser("u1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resumeByOrganiser() rejects a campaign that isn't PAUSED", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "LIVE" });

    await expect(communityCampaignsService.resumeByOrganiser("u1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resumeByOrganiser() resumes a paused campaign owned by the caller", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "PAUSED" });
    m.communityCampaign.update.mockResolvedValue({ ...baseCampaign, status: "LIVE" });
    m.campaignParticipant.findMany.mockResolvedValue([]);

    const result = await communityCampaignsService.resumeByOrganiser("u1", "camp-1");

    expect(result.status).toBe("LIVE");
  });
});

describe("Organiser general change request — reuses the existing support-case model", () => {
  it("creates a CommunityBuySupportCase with caseType CAMPAIGN_CHANGE_REQUEST for the campaign's own organiser", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1",
      organiser: { userId: "org-user-1" },
      supplier: null,
      supplierAccount: null,
    });
    m.communityBuySupportCase.create.mockResolvedValue({
      id: "case-1", campaignId: "camp-1", participantId: "org-user-1", caseType: "CAMPAIGN_CHANGE_REQUEST", description: "Please extend deadline", internalNotes: null,
    });

    const result = await supportCaseService.create("org-user-1", "camp-1", { caseType: "CAMPAIGN_CHANGE_REQUEST" as never, description: "Please extend deadline" });

    expect(result.caseType).toBe("CAMPAIGN_CHANGE_REQUEST");
    expect(m.communityBuySupportCase.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ participantId: "org-user-1", caseType: "CAMPAIGN_CHANGE_REQUEST" }) }),
    );
  });

  it("rejects when the caller has no relationship to the campaign at all", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1",
      organiser: { userId: "org-user-1" },
      supplier: null,
      supplierAccount: null,
    });
    m.campaignParticipant.findUnique.mockResolvedValue(null);

    await expect(
      supportCaseService.create("random-user", "camp-1", { caseType: "CAMPAIGN_CHANGE_REQUEST" as never, description: "x" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("Organiser identity display preference", () => {
  it("updateOrganiserProfile() persists firstNameOnlyDisplay for the caller's own profile", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1", firstNameOnlyDisplay: true });
    m.organiserProfile.update.mockResolvedValue({ userId: "u1", id: "org-1", firstNameOnlyDisplay: false });

    const result = await organiserSupplierService.updateOrganiserProfile("u1", { firstNameOnlyDisplay: false });

    expect(result.firstNameOnlyDisplay).toBe(false);
    expect(m.organiserProfile.update).toHaveBeenCalledWith({ where: { userId: "u1" }, data: { firstNameOnlyDisplay: false } });
  });

  it("updateOrganiserProfile() rejects when no organiser profile exists yet", async () => {
    m.organiserProfile.findUnique.mockResolvedValue(null);

    await expect(organiserSupplierService.updateOrganiserProfile("u1", { firstNameOnlyDisplay: true })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("get() shows only the organiser's first name when firstNameOnlyDisplay is true", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign,
      supplier: null,
      supplierAccount: null,
      organiser: { firstNameOnlyDisplay: true, user: { name: "Adaeze Okonkwo" } },
      contributions: [],
      _count: { participants: 0 },
    });
    m.marketConfiguration.findUnique.mockResolvedValue(null);

    const result = await communityCampaignsService.get("camp-1");

    expect(result.organiserDisplayName).toBe("Adaeze");
  });

  it("get() shows the organiser's full name when firstNameOnlyDisplay is false", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign,
      supplier: null,
      supplierAccount: null,
      organiser: { firstNameOnlyDisplay: false, user: { name: "Adaeze Okonkwo" } },
      contributions: [],
      _count: { participants: 0 },
    });
    m.marketConfiguration.findUnique.mockResolvedValue(null);

    const result = await communityCampaignsService.get("camp-1");

    expect(result.organiserDisplayName).toBe("Adaeze Okonkwo");
  });

  it("listLive() computes organiserDisplayName per campaign", async () => {
    m.communityCampaign.findMany.mockResolvedValue([
      { ...baseCampaign, id: "camp-a", supplier: null, supplierAccount: null, organiser: { firstNameOnlyDisplay: true, user: { name: "Chidi Eze" } } },
      { ...baseCampaign, id: "camp-b", supplier: null, supplierAccount: null, organiser: { firstNameOnlyDisplay: false, user: { name: "Ngozi Uba" } } },
    ]);

    const result = await communityCampaignsService.listLive();

    expect(result.find((c) => c.id === "camp-a")?.organiserDisplayName).toBe("Chidi");
    expect(result.find((c) => c.id === "camp-b")?.organiserDisplayName).toBe("Ngozi Uba");
  });
});

describe("Admin unified issue notes field", () => {
  it("setAdminIssueNotes() updates only adminIssueNotes and audits the change", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE" });
    m.communityCampaign.update.mockResolvedValue({ ...baseCampaign, adminIssueNotes: "Buyer disputes delivery timing" });

    const result = await communityCampaignsService.setAdminIssueNotes("admin-1", "camp-1", "Buyer disputes delivery timing");

    expect(result.adminIssueNotes).toBe("Buyer disputes delivery timing");
    expect(m.communityCampaign.update).toHaveBeenCalledWith({ where: { id: "camp-1" }, data: { adminIssueNotes: "Buyer disputes delivery timing" } });
    expect(m.auditLog.create).toHaveBeenCalled();
  });

  it("setAdminIssueNotes() rejects an unknown campaign", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(null);

    await expect(communityCampaignsService.setAdminIssueNotes("admin-1", "missing", "note")).rejects.toMatchObject({ statusCode: 404 });
  });
});
