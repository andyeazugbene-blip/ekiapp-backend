/**
 * Handbook 10 / 14.9 / 14.11 - Community Buy admin operations: the central
 * campaign transition map, guarded supplier approval/rejection, Super-Admin
 * and readiness gating for market payments, the market update whitelist,
 * milestone notification dedupe and admin campaign messaging controls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    supplierAccount: { findUnique: vi.fn(), update: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), create: vi.fn() },
    communityCampaign: { findUnique: vi.fn(), findMany: vi.fn() },
    auditLog: { count: vi.fn() },
    user: { findUnique: vi.fn() },
    campaignParticipant: { findMany: vi.fn() },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../modules/community-buy/campaign-payout.service", () => ({ campaignPayoutService: { holdForSystemReason: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/admin/admin-roles.service", () => ({ adminRolesService: { userPermissions: vi.fn() } }));
vi.mock("../modules/community-buy/community-buy-privacy.service", () => ({
  isIndividualDeliveryEnabled: vi.fn().mockReturnValue(false),
  revokeDeliveryReferencesForSupplierAccount: vi.fn().mockResolvedValue(0),
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { adminRolesService } from "../modules/admin/admin-roles.service";
import { CAMPAIGN_TRANSITIONS, canTransitionCampaign, campaignSourcesFor, assertCampaignTransition } from "../modules/community-buy/campaign-transitions";
import { supplierAccountService, deriveSupplierStatuses, isSupplierPayoutReady } from "../modules/community-buy/supplier-account.service";
import { marketConfigurationService, sanitiseMarketUpdate, assertDependencies, getReadiness } from "../modules/community-buy/market-configuration.service";
import { milestoneFor, notifyProgressMilestone } from "../modules/community-buy/campaign-notifications";

const m = vi.mocked(prisma, true) as any;
const roles = vi.mocked(adminRolesService, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("campaign transition map (handbook 10.2)", () => {
  it("allows the handbook lifecycle and nothing else out of the terminal states", () => {
    expect(canTransitionCampaign("DRAFT", "UNDER_REVIEW")).toBe(true);
    expect(canTransitionCampaign("UNDER_REVIEW", "APPROVED")).toBe(true);
    expect(canTransitionCampaign("UNDER_REVIEW", "REJECTED")).toBe(true);
    expect(canTransitionCampaign("LIVE", "PAUSED")).toBe(true);
    expect(canTransitionCampaign("FULFILLING", "COMPLETED")).toBe(true);
    expect(canTransitionCampaign("FAILED", "REFUNDING")).toBe(true);
    for (const terminal of ["REJECTED", "CANCELLED", "FINANCIALLY_CLOSED"] as const) {
      expect(CAMPAIGN_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("refuses illegal jumps with a 409", () => {
    expect(canTransitionCampaign("DRAFT", "LIVE")).toBe(false);
    expect(canTransitionCampaign("COMPLETED", "LIVE")).toBe(false);
    expect(() => assertCampaignTransition("CANCELLED", "LIVE")).toThrowError(expect.objectContaining({ statusCode: 409 }));
  });

  it("campaignSourcesFor() is derived from the same map", () => {
    expect(campaignSourcesFor("COMPLETED")).toEqual(["FULFILLING"]);
    expect(campaignSourcesFor("LIVE")).toEqual(expect.arrayContaining(["APPROVED", "PAUSED", "RESCUE_WINDOW"]));
  });
});

describe("supplierAccountService.approve() guards (handbook 14.11)", () => {
  const complete = { id: "a1", userId: "u1", categories: ["grocery"], coverageRegions: ["GB"], stripeRequirementsDue: [], termsAcceptedAt: new Date(), legacySupplierProfileId: null };

  it.each(["CLOSED", "SUSPENDED", "REJECTED", "APPROVED", "PAUSED", "RESTRICTED"])("refuses to approve an account in %s", async (state) => {
    m.supplierAccount.findUnique.mockResolvedValue({ ...complete, supplierState: state });
    await expect(supplierAccountService.approve("a1", "admin")).rejects.toMatchObject({ statusCode: 409, code: "SUPPLIER_STATE_INVALID" });
    expect(m.supplierAccount.update).not.toHaveBeenCalled();
  });

  it("refuses an incomplete application, outstanding verification, or missing terms acceptance - with clear reasons", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ ...complete, supplierState: "UNDER_REVIEW", categories: [], stripeRequirementsDue: ["x"], termsAcceptedAt: null });
    await expect(supplierAccountService.approve("a1", "admin")).rejects.toMatchObject({
      statusCode: 409,
      details: { blockers: ["incomplete:categories", "verification_outstanding", "terms_not_accepted"] },
    });
  });

  it("approves a complete UNDER_REVIEW application, records the reviewer and notifies the supplier", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ ...complete, supplierState: "UNDER_REVIEW" });
    m.supplierAccount.update.mockResolvedValue({ ...complete, supplierState: "APPROVED" });
    m.user.findUnique.mockResolvedValue({ email: "s@example.com" });
    const result = await supplierAccountService.approve("a1", "admin-9");
    expect(result.supplierState).toBe("APPROVED");
    expect(m.supplierAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supplierState: "APPROVED", reviewedById: "admin-9" }) }));
    expect(vi.mocked(notificationsService.enqueue)).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", data: expect.objectContaining({ event: "supplier_approved" }) }));
  });

  it("reject() only works on pending applications and notifies with the reason", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ ...complete, supplierState: "APPROVED" });
    await expect(supplierAccountService.reject("a1", "not suitable", "admin")).rejects.toMatchObject({ statusCode: 409 });
    m.supplierAccount.findUnique.mockResolvedValue({ ...complete, supplierState: "UNDER_REVIEW" });
    m.supplierAccount.update.mockResolvedValue({ ...complete, supplierState: "REJECTED" });
    m.user.findUnique.mockResolvedValue({ email: "s@example.com" });
    await supplierAccountService.reject("a1", "documents unreadable", "admin");
    expect(vi.mocked(notificationsService.enqueue)).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("documents unreadable") }));
  });

  it("never offers Suspend on a pending application", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ ...complete, supplierState: "UNDER_REVIEW" });
    await expect(supplierAccountService.suspend("a1", "bad actor", "admin")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("derives separate application / account / payout statuses and the payout-readiness gate", () => {
    const ready = { supplierState: "APPROVED", approvedAt: new Date(), chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, stripeRequirementsDue: [] };
    expect(deriveSupplierStatuses(ready)).toEqual({ application: "APPROVED", account: "ACTIVE", payout: "READY" });
    expect(isSupplierPayoutReady(ready)).toBe(true);
    expect(isSupplierPayoutReady({ ...ready, payoutsEnabled: false })).toBe(false);
    expect(deriveSupplierStatuses({ supplierState: "SUSPENDED", approvedAt: new Date() }).account).toBe("SUSPENDED");
    expect(deriveSupplierStatuses({ supplierState: "REJECTED" }).application).toBe("REJECTED");
  });
});

describe("market configuration - whitelist, dependencies, gating (handbook 14.9)", () => {
  const base = {
    countryCode: "GB", currency: "GBP", communityBuyEnabled: true, communityBuyPaymentsEnabled: false, organiserApplicationsEnabled: true,
    supplierApplicationsEnabled: true, regularDeliveriesEnabled: false, paymentMode: "DISABLED", paymentProvider: "stripe",
    providerSupported: false, providerConfigChecked: false, legalApprovalRef: null, refundTested: false, testTransactionAt: null, readinessUnverified: false,
  };
  const readyMarket = { ...base, providerSupported: true, providerConfigChecked: true, legalApprovalRef: "LEG-1", refundTested: true, testTransactionAt: new Date("2026-09-01") };

  it("whitelists fields: rejects unknown and guarded keys, never forwards raw body", () => {
    expect(sanitiseMarketUpdate({ communityBuyEnabled: false, reason: "r" })).toEqual({ communityBuyEnabled: false });
    expect(() => sanitiseMarketUpdate({ id: "x" })).toThrowError(expect.objectContaining({ statusCode: 400 }));
    expect(() => sanitiseMarketUpdate({ mysteryField: 1 })).toThrowError(expect.objectContaining({ statusCode: 400 }));
    expect(() => sanitiseMarketUpdate({ communityBuyPaymentsEnabled: true })).toThrowError(expect.objectContaining({ statusCode: 403 }));
    expect(() => sanitiseMarketUpdate({ organiserFeeBps: -1 })).toThrowError(expect.objectContaining({ statusCode: 400 }));
    expect(() => sanitiseMarketUpdate({ paymentMode: "BOGUS" })).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("validates dependencies: CB off while applications/payments on, and subscriptions need a payments provider", () => {
    expect(() => assertDependencies(base as never, { communityBuyEnabled: false })).toThrowError(expect.objectContaining({ code: "MARKET_DEPENDENCY" }));
    expect(() => assertDependencies({ ...base, paymentProvider: null } as never, { regularDeliveriesEnabled: true })).toThrowError(expect.objectContaining({ code: "MARKET_DEPENDENCY" }));
    expect(() => assertDependencies({ ...base, paymentMode: "TEST" } as never, { regularDeliveriesEnabled: true })).not.toThrow();
  });

  it("readiness checklist is ready only when every item is satisfied", () => {
    expect(getReadiness(base).ready).toBe(false);
    expect(getReadiness(readyMarket).ready).toBe(true);
    expect(getReadiness({ ...readyMarket, refundTested: false }).items.find((i) => i.key === "refundTested")?.satisfied).toBe(false);
  });

  it("only a Super Administrator can enable payments", async () => {
    m.marketConfiguration.count.mockResolvedValue(5);
    m.marketConfiguration.findUnique.mockResolvedValue(readyMarket);
    roles.userPermissions.mockResolvedValue(["community_buy.mutate"]);
    await expect(marketConfigurationService.setPaymentsEnabled("GB", true, { actorId: "ops", reason: "Go live", approvalRef: "APP-1" })).rejects.toMatchObject({ statusCode: 403, code: "SUPER_ADMIN_REQUIRED" });
    expect(m.marketConfiguration.update).not.toHaveBeenCalled();
  });

  it("a Super Administrator is still refused without readiness, a reason, or an approval reference", async () => {
    m.marketConfiguration.count.mockResolvedValue(5);
    roles.userPermissions.mockResolvedValue(["admin.*"]);
    m.marketConfiguration.findUnique.mockResolvedValue(base);
    await expect(marketConfigurationService.setPaymentsEnabled("GB", true, { actorId: "su", reason: "Go live", approvalRef: "APP-1" })).rejects.toMatchObject({ statusCode: 409, code: "MARKET_READINESS_INCOMPLETE" });
    m.marketConfiguration.findUnique.mockResolvedValue(readyMarket);
    await expect(marketConfigurationService.setPaymentsEnabled("GB", true, { actorId: "su", reason: "ok", approvalRef: "APP-1" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(marketConfigurationService.setPaymentsEnabled("GB", true, { actorId: "su", reason: "Go live", approvalRef: "" })).rejects.toMatchObject({ statusCode: 400 });
    expect(m.marketConfiguration.update).not.toHaveBeenCalled();
  });

  it("enables payments for a Super Administrator with full readiness, reason and approval reference", async () => {
    m.marketConfiguration.count.mockResolvedValue(5);
    roles.userPermissions.mockResolvedValue(["admin.*"]);
    m.marketConfiguration.findUnique.mockResolvedValue(readyMarket);
    m.marketConfiguration.update.mockResolvedValue({ ...readyMarket, communityBuyPaymentsEnabled: true });
    const result = await marketConfigurationService.setPaymentsEnabled("GB", true, { actorId: "su", reason: "Go live after legal sign-off", approvalRef: "APP-1" });
    expect(result.communityBuyPaymentsEnabled).toBe(true);
    expect(m.marketConfiguration.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ communityBuyPaymentsEnabled: true, readinessApprovedById: "su", readinessUnverified: false }),
    }));
  });

  it("update() applies only whitelisted fields to Prisma", async () => {
    m.marketConfiguration.count.mockResolvedValue(5);
    m.marketConfiguration.findUnique.mockResolvedValue({ ...base, communityBuyPaymentsEnabled: false });
    m.marketConfiguration.update.mockResolvedValue(base);
    await marketConfigurationService.update("gb", { supplierApplicationsEnabled: false, reason: "pause" });
    expect(m.marketConfiguration.update).toHaveBeenCalledWith({ where: { countryCode: "GB" }, data: { supplierApplicationsEnabled: false } });
  });
});

describe("progress milestones and notification dedupe (handbook 10.4)", () => {
  it("milestoneFor() maps progress to the highest crossed milestone", () => {
    expect(milestoneFor(2, 10, 5)).toBeNull();
    expect(milestoneFor(3, 10, 5)).toBe(25);
    expect(milestoneFor(5, 10, 5)).toBe(50);
    expect(milestoneFor(8, 10, 5)).toBe(75);
    expect(milestoneFor(12, 10, 5)).toBe(100);
    expect(milestoneFor(3, null, null)).toBeNull();
  });

  it("sends each milestone once per recipient using a deterministic dedupeKey", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      title: "Rice", confirmedShares: 5, goalShares: 10, minimumShares: 5,
      organiser: { userId: "org" }, participants: [{ userId: "p1" }, { userId: "p2" }],
    });
    await notifyProgressMilestone("camp-1");
    const calls = vi.mocked(notificationsService.enqueue).mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey);
    expect(calls).toEqual(["milestone:camp-1:50:org", "milestone:camp-1:50:p1", "milestone:camp-1:50:p2"]);
    await notifyProgressMilestone("camp-1");
    const second = vi.mocked(notificationsService.enqueue).mock.calls.slice(3).map((c) => (c[0] as { dedupeKey: string }).dedupeKey);
    expect(second).toEqual(calls); // identical keys -> notificationsService/DB unique constraint suppresses duplicates
  });
});
