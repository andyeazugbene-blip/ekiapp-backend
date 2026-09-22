/**
 * Phase 3 (address + privacy foundation) — focused tests for organiser
 * receiving configuration (collection address / delivery coverage areas),
 * buyer delivery address collection + coverage validation, and the privacy
 * boundary: the owning organiser may see a buyer's address for a DELIVERY
 * campaign, but a supplier never does, through any path. Mirrors the
 * existing Prisma-mocked unit-test convention (see community-buy.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    campaignParticipant: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn() },
    campaignContribution: { create: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn(), aggregate: vi.fn() },
    buyerPaymentMethod: { findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    communityBuyDataAccessLog: { create: vi.fn() },
    // Buyer-country eligibility gate (join()/pledge() — buyer-country.service.ts).
    user: { findUnique: vi.fn().mockResolvedValue({ country: "United Kingdom" }) },
    $transaction: vi.fn(),
  },
}));
vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() } } }));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { trigger: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";
import { communityBuyManifestService } from "../modules/community-buy/community-buy-manifest.service";

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
  pricePerShareMinor: 1000,
  quantityPerOrder: 1,
  unit: "kg",
  deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  termsLockedAt: null,
  confirmedShares: 0,
  deliveryPreference: "COLLECTION",
  collectionAddressLine1: null,
  collectionAddressLine2: null,
  collectionCity: null,
  collectionPostcode: null,
  deliveryCoverageAreas: [] as string[],
  fulfilmentOwner: "SUPPLIER",
  paymentMode: "PLEDGE_THEN_CHARGE",
};

describe("Organiser receiving configuration — validation (create/update)", () => {
  it("rejects a blank collection address field", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });

    await expect(
      communityCampaignsService.create("u1", { title: "Rice buy", country: "GB", collectionAddressLine1: "   " } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("normalizes deliveryCoverageAreas — trims, uppercases, dedupes, drops empties", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });
    m.communityCampaign.create.mockResolvedValue({ ...baseCampaign, deliveryCoverageAreas: ["SW1", "E14"] });

    await communityCampaignsService.create("u1", { title: "Rice buy", country: "GB", deliveryCoverageAreas: [" sw1 ", "sw1", "E14", "  "] } as never);

    expect(m.communityCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryCoverageAreas: ["SW1", "E14"] }) }),
    );
  });

  it("rejects a non-array deliveryCoverageAreas", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, organiserApplicationsEnabled: true });

    await expect(
      communityCampaignsService.create("u1", { title: "Rice buy", country: "GB", deliveryCoverageAreas: "SW1" } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("update() persists collection address fields", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", status: "DRAFT" });
    m.communityCampaign.update.mockResolvedValue({ ...baseCampaign, collectionAddressLine1: "12 High Street" });

    await communityCampaignsService.update("u1", "camp-1", { collectionAddressLine1: "12 High Street", collectionCity: "London", collectionPostcode: "SW1A 1AA" } as never);

    expect(m.communityCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ collectionAddressLine1: "12 High Street", collectionCity: "London", collectionPostcode: "SW1A 1AA" }) }),
    );
  });
});

describe("submit() — receiving configuration gate", () => {
  it("blocks submit when deliveryPreference is COLLECTION and no collection address is set", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isVerified: true, isRestricted: false });
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign, organiserId: "org-1", status: "DRAFT", deliveryPreference: "COLLECTION",
    });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true });

    await expect(communityCampaignsService.submit("u1", "camp-1")).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({ missing: expect.arrayContaining(["collectionAddressLine1", "collectionCity", "collectionPostcode"]) }),
    });
  });

  it("blocks submit when deliveryPreference is DELIVERY and no coverage areas are set", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isVerified: true, isRestricted: false });
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign, organiserId: "org-1", status: "DRAFT", deliveryPreference: "DELIVERY", deliveryCoverageAreas: [],
    });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true });

    await expect(communityCampaignsService.submit("u1", "camp-1")).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({ missing: expect.arrayContaining(["deliveryCoverageAreas"]) }),
    });
  });

  it("allows submit when deliveryPreference is COLLECTION and the collection address is fully set", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isVerified: true, isRestricted: false });
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign, organiserId: "org-1", status: "DRAFT", deliveryPreference: "COLLECTION", fulfilmentOwner: "SELF",
      collectionAddressLine1: "12 High Street", collectionCity: "London", collectionPostcode: "SW1A 1AA",
    });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true });
    m.communityCampaign.update.mockResolvedValue({ status: "UNDER_REVIEW" });

    const result = await communityCampaignsService.submit("u1", "camp-1");
    expect(result.status).toBe("UNDER_REVIEW");
  });
});

describe("Buyer delivery address — collected only when required, validated against coverage", () => {
  it("a COLLECTION campaign never requires or persists a delivery address, even if one is passed", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", deliveryPreference: "COLLECTION" });
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    });
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: "buyer-1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" });
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" });

    const txCampaign = { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-1", maximumShares: 20, confirmedShares: 0, termsLockedAt: null }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() };
    const txContribution = { create: vi.fn().mockResolvedValue({ id: "contrib-1" }) };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", status: "PLEDGED", participant: { userId: "buyer-1" } });

    await campaignContributionsService.pledge("buyer-1", "camp-1", 1, "pm-1", { recipientName: "Ignored", addressLine1: "Ignored", city: "Ignored", postcode: "IGNORED" });

    const createCall = txContribution.create.mock.calls[0][0];
    expect(createCall.data.deliveryAddressLine1).toBeUndefined();
    expect(createCall.data.deliveryRecipientName).toBeUndefined();
  });

  it("rejects a DELIVERY pledge with no address at all", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", deliveryPreference: "DELIVERY", deliveryCoverageAreas: ["SW1"] });
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    });

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-1", 1, "pm-1"),
    ).rejects.toMatchObject({ code: "DELIVERY_ADDRESS_REQUIRED" });
  });

  it("rejects a DELIVERY pledge with an address outside the configured coverage areas", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", deliveryPreference: "DELIVERY", deliveryCoverageAreas: ["SW1"] });
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    });

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-1", 1, "pm-1", { recipientName: "Ada", addressLine1: "1 Elm St", city: "Manchester", postcode: "M1 1AA" }),
    ).rejects.toMatchObject({ code: "DELIVERY_ADDRESS_OUT_OF_COVERAGE" });
  });

  it("rejects every DELIVERY pledge when the campaign has no coverage areas configured at all", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", deliveryPreference: "DELIVERY", deliveryCoverageAreas: [] });
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    });

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-1", 1, "pm-1", { recipientName: "Ada", addressLine1: "1 SW1 Ave", city: "London", postcode: "SW1A 1AA" }),
    ).rejects.toMatchObject({ code: "DELIVERY_ADDRESS_OUT_OF_COVERAGE" });
  });

  it("accepts and persists a DELIVERY pledge whose postcode matches a configured coverage area (prefix match)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "LIVE", deliveryPreference: "DELIVERY", deliveryCoverageAreas: ["SW1"] });
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    });
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: "buyer-1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" });
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" });

    const txCampaign = { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-1", maximumShares: 20, confirmedShares: 0, termsLockedAt: null }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() };
    const txContribution = { create: vi.fn().mockResolvedValue({ id: "contrib-1" }) };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", status: "PLEDGED", participant: { userId: "buyer-1" } });

    await campaignContributionsService.pledge("buyer-1", "camp-1", 1, "pm-1", { recipientName: "Ada", addressLine1: "1 SW1 Ave", city: "London", postcode: "sw1a 1aa" });

    expect(txContribution.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryRecipientName: "Ada", deliveryAddressLine1: "1 SW1 Ave", deliveryCity: "London", deliveryPostcode: "sw1a 1aa" }) }),
    );
  });
});

describe("Privacy — organiser sees address only for a DELIVERY campaign; supplier never does", () => {
  it("listParticipantsForOrganiser() includes deliveryAddress for a DELIVERY campaign and logs an ADDRESS_DETAIL/VIEWED access", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", deliveryPreference: "DELIVERY", fulfilmentOwner: "SUPPLIER" });
    m.campaignParticipant.findMany.mockResolvedValue([
      {
        userId: "buyer-1",
        joinedAt: new Date(),
        user: { name: "Ada Buyer", email: "ada@example.com" },
        contributions: [{
          quantity: 2, amount: 2000, isOrganiserTopUp: false, createdAt: new Date(),
          deliveryRecipientName: "Ada Buyer", deliveryAddressLine1: "1 SW1 Ave", deliveryAddressLine2: null, deliveryCity: "London", deliveryPostcode: "SW1A 1AA",
        }],
      },
    ]);

    const result = await communityCampaignsService.listParticipantsForOrganiser("u1", "camp-1");

    expect(result[0].deliveryAddress).toEqual({
      recipientName: "Ada Buyer", addressLine1: "1 SW1 Ave", addressLine2: null, city: "London", postcode: "SW1A 1AA",
    });
    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ accessorRole: "ORGANISER", dataCategory: "ADDRESS_DETAIL", action: "VIEWED" }) }),
    );
  });

  // Figma S35 — deliveryResponsibility === SUPPLIER means the organiser is
  // NOT the responsible party; this endpoint must withhold it here too
  // (the supplier reads it instead, via getFulfilmentDeliveriesForAccount()).
  it("listParticipantsForOrganiser() withholds the address when deliveryResponsibility is SUPPLIER", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", deliveryPreference: "DELIVERY", deliveryResponsibility: "SUPPLIER", fulfilmentOwner: "SUPPLIER" });
    m.campaignParticipant.findMany.mockResolvedValue([
      {
        userId: "buyer-1", joinedAt: new Date(), user: { name: "Ada Buyer", email: "ada@example.com" },
        contributions: [{ quantity: 2, amount: 2000, isOrganiserTopUp: false, createdAt: new Date(), deliveryRecipientName: "Ada Buyer", deliveryAddressLine1: "1 SW1 Ave", deliveryAddressLine2: null, deliveryCity: "London", deliveryPostcode: "SW1A 1AA" }],
      },
    ]);

    const result = await communityCampaignsService.listParticipantsForOrganiser("u1", "camp-1");

    expect(Object.keys(result[0])).not.toContain("deliveryAddress");
    expect(m.communityBuyDataAccessLog.create).not.toHaveBeenCalled();
  });

  it("listParticipantsForOrganiser() still includes the address when deliveryResponsibility is SHARED", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", deliveryPreference: "DELIVERY", deliveryResponsibility: "SHARED", fulfilmentOwner: "SUPPLIER" });
    m.campaignParticipant.findMany.mockResolvedValue([
      {
        userId: "buyer-1", joinedAt: new Date(), user: { name: "Ada Buyer", email: "ada@example.com" },
        contributions: [{ quantity: 2, amount: 2000, isOrganiserTopUp: false, createdAt: new Date(), deliveryRecipientName: "Ada Buyer", deliveryAddressLine1: "1 SW1 Ave", deliveryAddressLine2: null, deliveryCity: "London", deliveryPostcode: "SW1A 1AA", deliveryPhone: null, deliveryInstructions: null }],
      },
    ]);

    const result = await communityCampaignsService.listParticipantsForOrganiser("u1", "camp-1");

    expect(result[0].deliveryAddress).toBeTruthy();
  });

  it("listParticipantsForOrganiser() never includes a deliveryAddress key for a COLLECTION campaign, and logs no address access", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1", deliveryPreference: "COLLECTION", fulfilmentOwner: "SUPPLIER" });
    m.campaignParticipant.findMany.mockResolvedValue([
      {
        userId: "buyer-1",
        joinedAt: new Date(),
        user: { name: "Ada Buyer", email: "ada@example.com" },
        contributions: [{ quantity: 2, amount: 2000, isOrganiserTopUp: false, createdAt: new Date(), deliveryRecipientName: null, deliveryAddressLine1: null, deliveryAddressLine2: null, deliveryCity: null, deliveryPostcode: null }],
      },
    ]);

    const result = await communityCampaignsService.listParticipantsForOrganiser("u1", "camp-1");

    expect(Object.keys(result[0])).not.toContain("deliveryAddress");
    expect(m.communityBuyDataAccessLog.create).not.toHaveBeenCalled();
  });

  it("listParticipantsForOrganiser() is still gated by requireOwnedByOrganiser — a non-owner never reaches the address logic", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ userId: "u1", id: "org-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "someone-else", deliveryPreference: "DELIVERY" });

    await expect(communityCampaignsService.listParticipantsForOrganiser("u1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.campaignParticipant.findMany).not.toHaveBeenCalled();
  });

  it("the supplier-facing manifest never includes an address, even when the underlying contribution row has real address data", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED", controlScope: null });
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", deliveryPreference: "DELIVERY" });
    // Simulates a contribution that DOES have a real address on it (a
    // DELIVERY campaign's captured pledge) — buildManifest()'s own select/
    // map must still never surface it.
    m.campaignContribution.findMany.mockResolvedValue([
      {
        id: "contrib-1", participantId: "part-1", quantity: 2,
        deliveryReference: { status: "PENDING", deliveryMethod: "DELIVERY" },
      },
    ]);

    const manifest = await communityBuyManifestService.getManifestForAccount("user-1", "camp-1");

    expect(manifest).toEqual([
      { participantReference: "part-1", contributionId: "contrib-1", quantity: 2, deliveryMethod: "DELIVERY", deliveryStatus: "PENDING" },
    ]);
    const rendered = JSON.stringify(manifest);
    expect(rendered).not.toMatch(/address/i);
    expect(rendered).not.toMatch(/SW1|postcode|recipientName/i);
  });
});
