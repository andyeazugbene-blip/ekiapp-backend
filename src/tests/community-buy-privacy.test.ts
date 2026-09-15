/**
 * M4 — Delivery + privacy infrastructure. Mapped to AT-38..AT-44.
 * Covers: individual-delivery gating (two independent bypass points),
 * isDataAccessAllowed()'s control_scope table, DeliveryReference lifecycle
 * (create-on-capture, revocation, expiry), and the data-access-log writer's
 * never-throws contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    campaignContribution: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    campaignFulfilment: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    deliveryReference: { upsert: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    communityBuyDataAccessLog: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import {
  isIndividualDeliveryEnabled,
  isDataAccessAllowed,
  recordDataAccess,
  createDeliveryReferenceForContribution,
  revokeDeliveryReferencesForCampaign,
  revokeDeliveryReferencesForSupplierAccount,
  privacyExpirySweep,
  searchDataAccessLog,
  FULFILMENT_ACCESS_PRESERVED_SCOPE,
} from "../modules/community-buy/community-buy-privacy.service";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignFulfilmentService } from "../modules/community-buy/campaign-fulfilment.service";

const m = vi.mocked(prisma, true);

const ORIGINAL_FLAG = process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED;
  else process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED = ORIGINAL_FLAG;
});

describe("isIndividualDeliveryEnabled() — the production kill-switch", () => {
  it("defaults false when unset", () => {
    expect(isIndividualDeliveryEnabled()).toBe(false);
  });
  it("is true only for the exact string \"true\"", () => {
    process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED = "1";
    expect(isIndividualDeliveryEnabled()).toBe(false);
    process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED = "true";
    expect(isIndividualDeliveryEnabled()).toBe(true);
  });
});

describe("AT-38: deliveryPreference=DELIVERY is rejected at campaign creation/update while the flag is off", () => {
  it("create() rejects DELIVERY when the flag is off", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isVerified: true, isRestricted: false } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);
    await expect(
      communityCampaignsService.create("u1", { title: "Rice", country: "GB", deliveryPreference: "DELIVERY" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INDIVIDUAL_DELIVERY_NOT_AVAILABLE" });
  });

  it("update() rejects DELIVERY when the flag is off, and never calls prisma.update", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: null, supplierId: null } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" } as never);
    await expect(
      communityCampaignsService.update("u1", "camp-1", { deliveryPreference: "DELIVERY" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INDIVIDUAL_DELIVERY_NOT_AVAILABLE" });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("never silently downgrades — COLLECTION is never substituted for a rejected DELIVERY request", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: null, supplierId: null } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" } as never);
    await expect(communityCampaignsService.update("u1", "camp-1", { deliveryPreference: "DELIVERY" })).rejects.toThrow();
    // The whole update() call must fail — not just the field silently dropped.
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("update() accepts DELIVERY once the flag is genuinely on", async () => {
    process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED = "true";
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: null, supplierId: null } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", deliveryPreference: "DELIVERY" } as never);
    const result = await communityCampaignsService.update("u1", "camp-1", { deliveryPreference: "DELIVERY" });
    expect(result.deliveryPreference).toBe("DELIVERY");
  });
});

describe("AT-38: setPlan()/setPlanForAccount() is a second, independent bypass — closed the same way", () => {
  function mockOwnedCampaign(deliveryPreference: string) {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1" } as never);
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1", supplierAccountId: "acct-1", organiserId: "org-1", title: "Rice", deliveryPreference } as never);
    m.campaignFulfilment.findUnique.mockResolvedValue({ campaignId: "camp-1", status: "INVENTORY_CONFIRMED", method: null } as never);
  }

  it("rejects method:DELIVERY on the legacy Vendor path when the flag is off", async () => {
    mockOwnedCampaign("DELIVERY");
    await expect(
      campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "DELIVERY" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INDIVIDUAL_DELIVERY_NOT_AVAILABLE" });
  });

  it("rejects method:DELIVERY on the SupplierAccount path when the flag is off", async () => {
    mockOwnedCampaign("DELIVERY");
    await expect(
      campaignFulfilmentService.setPlanForAccount("user-1", "camp-1", { method: "DELIVERY" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INDIVIDUAL_DELIVERY_NOT_AVAILABLE" });
  });

  it("rejects method:DELIVERY even with the flag ON if the campaign was created as COLLECTION — the cross-check", async () => {
    process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED = "true";
    mockOwnedCampaign("COLLECTION");
    await expect(
      campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "DELIVERY" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_METHOD_MISMATCH" });
  });

  it("accepts method:DELIVERY only when both the flag is on AND the campaign itself is DELIVERY", async () => {
    process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED = "true";
    mockOwnedCampaign("DELIVERY");
    m.campaignFulfilment.updateMany.mockResolvedValue({ count: 1 } as never);
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ campaignId: "camp-1", method: "DELIVERY" } as never);
    await expect(campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "DELIVERY" })).resolves.toBeTruthy();
  });

  it("COLLECTION is always allowed regardless of the flag", async () => {
    mockOwnedCampaign("COLLECTION");
    m.campaignFulfilment.updateMany.mockResolvedValue({ count: 1 } as never);
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ campaignId: "camp-1", method: "COLLECTION" } as never);
    await expect(campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "COLLECTION" })).resolves.toBeTruthy();
  });
});

describe("isDataAccessAllowed() — spec §14.4's revocation table", () => {
  it("APPROVED always allows access", () => {
    expect(isDataAccessAllowed("APPROVED", null)).toBe(true);
  });
  it("PAUSED preserves existing access", () => {
    expect(isDataAccessAllowed("PAUSED", null)).toBe(true);
  });
  it("RESTRICTED with no scope defaults to revoke (the safer default)", () => {
    expect(isDataAccessAllowed("RESTRICTED", null)).toBe(false);
  });
  it("RESTRICTED with an unrecognised scope still defaults to revoke", () => {
    expect(isDataAccessAllowed("RESTRICTED", "something_else")).toBe(false);
  });
  it("RESTRICTED with fulfilment_access_preserved allows access", () => {
    expect(isDataAccessAllowed("RESTRICTED", FULFILMENT_ACCESS_PRESERVED_SCOPE)).toBe(true);
  });
  it("SUSPENDED always denies, even with a preserved scope", () => {
    expect(isDataAccessAllowed("SUSPENDED", FULFILMENT_ACCESS_PRESERVED_SCOPE)).toBe(false);
  });
  it("CLOSED always denies", () => {
    expect(isDataAccessAllowed("CLOSED", null)).toBe(false);
  });
  it("an unrecognised/unreachable state denies by default (fail closed)", () => {
    expect(isDataAccessAllowed("NOT_STARTED", null)).toBe(false);
  });
});

describe("recordDataAccess() — never throws (AT-43)", () => {
  it("swallows a write failure and logs it instead of throwing", async () => {
    m.communityBuyDataAccessLog.create.mockRejectedValue(new Error("DB down"));
    await expect(
      recordDataAccess({ campaignId: "camp-1", accessorUserId: "u1", accessorRole: "SUPPLIER", dataCategory: "MANIFEST", action: "VIEWED", purposeCode: "test" }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it("writes exactly one row per call with the given shape", async () => {
    m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);
    await recordDataAccess({ campaignId: "camp-1", contributionId: "c1", accessorUserId: "u1", accessorRole: "SUPPLIER", dataCategory: "MANIFEST", action: "VIEWED", purposeCode: "fulfilment_manifest" });
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledTimes(1);
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ campaignId: "camp-1", contributionId: "c1", action: "VIEWED", dataCategory: "MANIFEST" }),
    }));
  });
});

describe("createDeliveryReferenceForContribution() — capture-dependent creation (AT-39's foundation)", () => {
  it("creates a NOT_REQUIRED row for a COLLECTION campaign", async () => {
    m.campaignContribution.findUnique.mockResolvedValue({ campaignId: "camp-1", participantId: "part-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ deliveryPreference: "COLLECTION" } as never);
    await createDeliveryReferenceForContribution("contrib-1");
    expect(m.deliveryReference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { contributionId: "contrib-1" },
      create: expect.objectContaining({ campaignId: "camp-1", participantId: "part-1", deliveryMethod: "COLLECTION", status: "NOT_REQUIRED" }),
    }));
  });

  it("creates a PENDING row for a DELIVERY campaign", async () => {
    m.campaignContribution.findUnique.mockResolvedValue({ campaignId: "camp-1", participantId: "part-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ deliveryPreference: "DELIVERY" } as never);
    await createDeliveryReferenceForContribution("contrib-1");
    expect(m.deliveryReference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ deliveryMethod: "DELIVERY", status: "PENDING" }),
    }));
  });

  it("never throws even if the contribution can't be found (e.g. a stale/deleted id)", async () => {
    m.campaignContribution.findUnique.mockResolvedValue(null);
    await expect(createDeliveryReferenceForContribution("missing")).resolves.toBeUndefined();
    expect(m.deliveryReference.upsert).not.toHaveBeenCalled();
  });

  it("never throws even if the upsert itself fails — must not break the payment flow it rides behind", async () => {
    m.campaignContribution.findUnique.mockResolvedValue({ campaignId: "camp-1", participantId: "part-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ deliveryPreference: "COLLECTION" } as never);
    m.deliveryReference.upsert.mockRejectedValue(new Error("DB down"));
    await expect(createDeliveryReferenceForContribution("contrib-1")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("revocation — SUSPENDED/CLOSED/restriction/replacement all funnel through the same bulk-revoke", () => {
  it("revokeDeliveryReferencesForCampaign revokes every non-terminal row and writes exactly one ACCESS_REVOKED log row", async () => {
    m.deliveryReference.updateMany.mockResolvedValue({ count: 3 } as never);
    m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);
    const count = await revokeDeliveryReferencesForCampaign("camp-1", "supplier_restricted", "admin-1");
    expect(count).toBe(3);
    expect(m.deliveryReference.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ campaignId: "camp-1" }),
      data: expect.objectContaining({ status: "REVOKED", revocationReason: "supplier_restricted" }),
    }));
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledTimes(1);
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ campaignId: "camp-1", action: "ACCESS_REVOKED" }),
    }));
  });

  it("revokeDeliveryReferencesForSupplierAccount fans out across every campaign the account is assigned to", async () => {
    m.communityCampaign.findMany.mockResolvedValue([{ id: "camp-1" }, { id: "camp-2" }] as never);
    m.deliveryReference.updateMany.mockResolvedValue({ count: 1 } as never);
    m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);
    const total = await revokeDeliveryReferencesForSupplierAccount("acct-1", "supplier_suspended", "admin-1");
    expect(total).toBe(2);
    expect(m.deliveryReference.updateMany).toHaveBeenCalledTimes(2);
    // One ACCESS_REVOKED log row per affected campaign, not per DeliveryReference row.
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledTimes(2);
  });

  it("is a safe no-op when there is nothing to revoke", async () => {
    m.deliveryReference.updateMany.mockResolvedValue({ count: 0 } as never);
    m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);
    const count = await revokeDeliveryReferencesForCampaign("camp-1", "supplier_replaced", "admin-1");
    expect(count).toBe(0);
  });
});

describe("privacyExpirySweep() — spec §17.2 privacy_expiry (daily)", () => {
  it("revokes an expired DeliveryReference and logs the revocation", async () => {
    m.deliveryReference.findMany.mockResolvedValue([{ id: "dr-1", campaignId: "camp-1" }] as never);
    m.deliveryReference.updateMany.mockResolvedValue({ count: 1 } as never);
    m.communityBuyDataAccessLog.findMany.mockResolvedValue([]);
    m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);

    const result = await privacyExpirySweep();

    expect(result.deliveryReferencesRevoked).toBe(1);
    expect(m.deliveryReference.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "dr-1" }),
      data: expect.objectContaining({ status: "REVOKED", revocationReason: "privacy_expiry" }),
    }));
  });

  it("a losing concurrent claim on the same DeliveryReference is not double-counted", async () => {
    m.deliveryReference.findMany.mockResolvedValue([{ id: "dr-1", campaignId: "camp-1" }] as never);
    m.deliveryReference.updateMany.mockResolvedValue({ count: 0 } as never); // another sweep already claimed it
    m.communityBuyDataAccessLog.findMany.mockResolvedValue([]);

    const result = await privacyExpirySweep();
    expect(result.deliveryReferencesRevoked).toBe(0);
  });

  it("expires a past-due emergency-disclosure grant", async () => {
    m.deliveryReference.findMany.mockResolvedValue([]);
    m.communityBuyDataAccessLog.findMany.mockResolvedValue([{ id: "log-1", campaignId: "camp-1" }] as never);
    m.communityBuyDataAccessLog.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await privacyExpirySweep();
    expect(result.accessGrantsExpired).toBe(1);
    expect(m.communityBuyDataAccessLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "log-1" }),
      data: expect.objectContaining({ revocationReason: "privacy_expiry" }),
    }));
  });
});

describe("searchDataAccessLog() — admin audit search surface", () => {
  it("passes filters through and bounds the limit", async () => {
    m.communityBuyDataAccessLog.findMany.mockResolvedValue([]);
    await searchDataAccessLog({ campaignId: "camp-1", action: "VIEWED", limit: 10000 });
    expect(m.communityBuyDataAccessLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ campaignId: "camp-1", action: "VIEWED" }),
      take: 500,
    }));
  });
});
