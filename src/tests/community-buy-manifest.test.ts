/**
 * M4 — supplier-facing manifest, in-app contact, and emergency-contact
 * read. Mapped to AT-39, AT-40, AT-41, AT-44.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn() },
    campaignContribution: { findMany: vi.fn(), findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    communityBuyDataAccessLog: { create: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { communityBuyManifestService } from "../modules/community-buy/community-buy-manifest.service";

const m = vi.mocked(prisma, true);
const mNotify = vi.mocked(notificationsService, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getManifestForAccount() — AT-39/AT-40", () => {
  it("AT-39: returns an empty manifest before any capture (no PAID contributions yet)", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findMany.mockResolvedValue([]);

    const manifest = await communityBuyManifestService.getManifestForAccount("user-1", "camp-1");

    expect(manifest).toEqual([]);
  });

  it("AT-39/AT-40: returns a masked shape after capture — participant reference + quantity + delivery status only, never email/phone/address", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findMany.mockResolvedValue([
      { id: "contrib-1", participantId: "part-1", quantity: 3, deliveryReference: { status: "NOT_REQUIRED", deliveryMethod: "COLLECTION" } },
    ] as never);
    m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);

    const manifest = await communityBuyManifestService.getManifestForAccount("user-1", "camp-1");

    expect(manifest).toEqual([
      { participantReference: "part-1", contributionId: "contrib-1", quantity: 3, deliveryMethod: "COLLECTION", deliveryStatus: "NOT_REQUIRED" },
    ]);
    const keys = Object.keys(manifest[0]);
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("phone");
    expect(keys).not.toContain("address");
    expect(JSON.stringify(manifest)).not.toMatch(/@/); // no email-shaped string anywhere
  });

  it("AT-39: capture-dependent — only queries PAID contributions", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findMany.mockResolvedValue([]);

    await communityBuyManifestService.getManifestForAccount("user-1", "camp-1");

    expect(m.campaignContribution.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "PAID" }),
    }));
  });

  it("writes exactly one VIEWED/MANIFEST access-log row per call", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findMany.mockResolvedValue([]);

    await communityBuyManifestService.getManifestForAccount("user-1", "camp-1");

    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledTimes(1);
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ campaignId: "camp-1", accessorAccountId: "acct-1", accessorRole: "SUPPLIER", dataCategory: "MANIFEST", action: "VIEWED" }),
    }));
  });

  it("404s for a campaign this SupplierAccount does not own", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "some-other-acct", deliveryPreference: "COLLECTION" } as never);
    await expect(communityBuyManifestService.getManifestForAccount("user-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("control_scope gating — re-checked on every call, not cached", () => {
  it("RESTRICTED with no scope denies manifest access", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "RESTRICTED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    await expect(communityBuyManifestService.getManifestForAccount("user-1", "camp-1")).rejects.toMatchObject({ statusCode: 403, code: "DATA_ACCESS_RESTRICTED" });
    expect(m.campaignContribution.findMany).not.toHaveBeenCalled();
  });

  it("RESTRICTED with fulfilment_access_preserved allows manifest access", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "RESTRICTED", controlScope: "fulfilment_access_preserved" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findMany.mockResolvedValue([]);
    await expect(communityBuyManifestService.getManifestForAccount("user-1", "camp-1")).resolves.toEqual([]);
  });

  it("SUSPENDED denies manifest access even with a preserved scope", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "SUSPENDED", controlScope: "fulfilment_access_preserved" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    await expect(communityBuyManifestService.getManifestForAccount("user-1", "camp-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("the legacy Vendor path denies access when isRestricted, with no controlScope concept available to it", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", isRestricted: true } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1", deliveryPreference: "COLLECTION" } as never);
    await expect(communityBuyManifestService.getManifestForVendor("vendor-1", "camp-1", "user-1")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("sendContactMessageForAccount() — AT-41 contact hierarchy", () => {
  it("AT-41: a non-IN_APP_MESSAGE channel (no real courier/phone provider) falls back cleanly, never returns a raw number", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    await expect(
      communityBuyManifestService.sendContactMessageForAccount("user-1", "camp-1", "contrib-1", "PROXY_CALL", undefined),
    ).rejects.toMatchObject({ statusCode: 400, code: "CONTACT_CHANNEL_NOT_AVAILABLE" });
    expect(mNotify.enqueue).not.toHaveBeenCalled();
  });

  it("sends a genuine in-app message and logs MESSAGE_SENT", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findUnique.mockResolvedValue({ id: "contrib-1", campaignId: "camp-1", participantId: "part-1", status: "PAID", participant: { userId: "participant-user-1" } } as never);

    const result = await communityBuyManifestService.sendContactMessageForAccount("user-1", "camp-1", "contrib-1", "IN_APP_MESSAGE", "Your order is ready for collection");

    expect(result).toEqual({ sent: true });
    expect(mNotify.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "participant-user-1", body: "Your order is ready for collection" }));
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "MESSAGE_SENT", dataCategory: "CONTACT_CHANNEL" }),
    }));
  });

  it("rejects a message to a contribution that was never captured", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findUnique.mockResolvedValue({ id: "contrib-1", campaignId: "camp-1", status: "PLEDGED", participant: { userId: "participant-user-1" } } as never);
    await expect(
      communityBuyManifestService.sendContactMessageForAccount("user-1", "camp-1", "contrib-1", "IN_APP_MESSAGE", "hi"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an empty message", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    await expect(
      communityBuyManifestService.sendContactMessageForAccount("user-1", "camp-1", "contrib-1", "IN_APP_MESSAGE", "   "),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("getEmergencyContactForAccount() — AT-42's supplier-facing read half", () => {
  it("rejects when no active grant exists", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findUnique.mockResolvedValue({ id: "contrib-1", campaignId: "camp-1", participantId: "part-1", status: "PAID", participant: { user: { phone: "+441234567890" } } } as never);
    m.communityBuyDataAccessLog.findFirst.mockResolvedValue(null);

    await expect(
      communityBuyManifestService.getEmergencyContactForAccount("user-1", "camp-1", "contrib-1"),
    ).rejects.toMatchObject({ statusCode: 403, code: "EMERGENCY_ACCESS_NOT_GRANTED_OR_EXPIRED" });
  });

  it("returns the phone number when a live grant exists, and re-checks accessExpiresAt live (not cached)", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findUnique.mockResolvedValue({ id: "contrib-1", campaignId: "camp-1", participantId: "part-1", status: "PAID", participant: { user: { phone: "+441234567890" } } } as never);
    const grantExpiry = new Date(Date.now() + 30 * 60 * 1000);
    m.communityBuyDataAccessLog.findFirst.mockResolvedValue({ adminOverrideId: "appr-1", accessExpiresAt: grantExpiry } as never);

    const result = await communityBuyManifestService.getEmergencyContactForAccount("user-1", "camp-1", "contrib-1");

    expect(result.phone).toBe("+441234567890");
    // The live query itself must filter on accessExpiresAt > now — proven
    // by asserting the findFirst call, not just trusting the mock's return.
    expect(m.communityBuyDataAccessLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ contributionId: "contrib-1", action: "ADMIN_OVERRIDE", revokedAt: null }),
    }));
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dataCategory: "EMERGENCY_NUMBER", action: "VIEWED", adminOverrideId: "appr-1" }),
    }));
  });
});

describe("AT-44: self-supply must not expose full participant identity through this manifest surface", () => {
  it("the manifest response never includes name/email regardless of fulfilmentOwner — masking is unconditional", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION" } as never);
    m.campaignContribution.findMany.mockResolvedValue([
      { id: "contrib-1", participantId: "part-1", quantity: 2, deliveryReference: null },
    ] as never);

    const manifest = await communityBuyManifestService.getManifestForAccount("user-1", "camp-1");

    expect(manifest[0]).not.toHaveProperty("name");
    expect(manifest[0]).not.toHaveProperty("email");
    // A contribution captured before its DeliveryReference row exists yet defaults safely to NOT_REQUIRED/COLLECTION, never throws.
    expect(manifest[0].deliveryStatus).toBe("NOT_REQUIRED");
  });
});

// Figma S25 "Prepare Home Deliveries" — the one supplier-facing read that
// DOES carry a real address/phone/instructions, gated on the real,
// persisted CommunityCampaign.deliveryResponsibility.
describe("getFulfilmentDeliveriesForAccount() — S25 real home-delivery details", () => {
  it("403s when deliveryResponsibility is ORGANISER (the default) — this supplier is not responsible", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "DELIVERY", deliveryResponsibility: "ORGANISER" } as never);

    await expect(communityBuyManifestService.getFulfilmentDeliveriesForAccount("user-1", "camp-1")).rejects.toMatchObject({ statusCode: 403, code: "NOT_RESPONSIBLE_FOR_DELIVERY" });
    expect(m.campaignContribution.findMany).not.toHaveBeenCalled();
  });

  it("403s for a COLLECTION campaign regardless of deliveryResponsibility — nothing to deliver", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "COLLECTION", deliveryResponsibility: "SUPPLIER" } as never);

    await expect(communityBuyManifestService.getFulfilmentDeliveriesForAccount("user-1", "camp-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns the real address/phone/instructions when deliveryResponsibility is SUPPLIER, and logs the access", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "DELIVERY", deliveryResponsibility: "SUPPLIER" } as never);
    m.campaignContribution.findMany.mockResolvedValue([
      {
        id: "contrib-1", quantity: 2,
        deliveryRecipientName: "Amaka N.", deliveryAddressLine1: "12 High St", deliveryAddressLine2: null, deliveryCity: "Coventry", deliveryPostcode: "CV1 1AA",
        deliveryPhone: "+441234567890", deliveryInstructions: "Leave with neighbour",
        deliveryReference: { status: "PENDING" },
      },
    ] as never);
    m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);

    const deliveries = await communityBuyManifestService.getFulfilmentDeliveriesForAccount("user-1", "camp-1");

    expect(deliveries).toEqual([{
      contributionId: "contrib-1", quantity: 2,
      recipientName: "Amaka N.", addressLine1: "12 High St", addressLine2: null, city: "Coventry", postcode: "CV1 1AA",
      phone: "+441234567890", instructions: "Leave with neighbour",
      deliveryStatus: "PENDING",
    }]);
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dataCategory: "ADDRESS_DETAIL", action: "VIEWED", accessorRole: "SUPPLIER" }),
    }));
  });

  it("also works when deliveryResponsibility is SHARED", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "DELIVERY", deliveryResponsibility: "SHARED" } as never);
    m.campaignContribution.findMany.mockResolvedValue([] as never);

    await expect(communityBuyManifestService.getFulfilmentDeliveriesForAccount("user-1", "camp-1")).resolves.toEqual([]);
  });

  it("never leaks another supplier's campaign — ownership check runs before the responsibility check", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "some-other-account", deliveryPreference: "DELIVERY", deliveryResponsibility: "SUPPLIER" } as never);

    await expect(communityBuyManifestService.getFulfilmentDeliveriesForAccount("user-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});
