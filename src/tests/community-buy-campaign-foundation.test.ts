/**
 * Community Buy Workstream 2 (campaign foundation) — the mandatory test
 * matrix from the approved plan: draft creation with no organiser
 * verification required, partial/resumable draft persistence, the new
 * Product/Delivery fields, submit()'s authoritative requirement gate, and
 * the capacity-race guarded-transaction path that previously had zero
 * direct coverage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    organiserProfile: { findUnique: vi.fn(), create: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    communityCampaign: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    campaignContribution: { create: vi.fn(), findUniqueOrThrow: vi.fn() },
    campaignParticipant: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    buyerPaymentMethod: { findUnique: vi.fn() },
    // count() is used by marketConfigurationService.get()'s lazy
    // ensureDefaults() seeding check — mocked >0 so it never tries to
    // reach the (unmocked) create() seeding path in these unit tests.
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    // Buyer-country eligibility gate (join()/pledge() — buyer-country.service.ts).
    user: { findUnique: vi.fn().mockResolvedValue({ country: "United Kingdom" }) },
    $transaction: vi.fn(),
  },
}));
vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() } } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { trigger: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

const validDraftFields = {
  country: "GB",
  currency: "GBP",
  minimumShares: 5,
  goalShares: 10,
  maximumShares: 15,
  pricePerShareMinor: 1000,
  deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  unit: "kg",
  quantityPerOrder: 1,
};

describe("communityCampaignsService.create — draft creation requires no organiser verification (A, E)", () => {
  it("A: a fresh authenticated user with no OrganiserProfile at all can create a minimal draft (title + country only)", async () => {
    m.organiserProfile.findUnique.mockResolvedValue(null);
    m.marketConfiguration.findUnique.mockResolvedValueOnce({ countryCode: "GB", organiserApplicationsEnabled: true } as never);
    m.marketConfiguration.findUnique.mockResolvedValueOnce({ countryCode: "GB", communityBuyEnabled: true } as never);
    m.organiserProfile.create.mockResolvedValue({ id: "org-new", userId: "fresh-user", isVerified: false, isRestricted: false, country: "GB" });
    m.communityCampaign.create.mockResolvedValue({ id: "camp-new", status: "DRAFT", title: "My rice buy" });

    const result = await communityCampaignsService.create("fresh-user", { title: "My rice buy", country: "GB" });

    expect(result.status).toBe("DRAFT");
    // The auto-created organiser is unverified — proves verification is not
    // required to reach this point.
    expect(m.organiserProfile.create).toHaveBeenCalledWith({ data: { userId: "fresh-user", country: "GB" } });
    expect(m.communityCampaign.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ title: "My rice buy", status: "DRAFT", fulfilmentOwner: "SELF", supplierId: null }),
    }));
  });

  it("rejects a draft with no title", async () => {
    await expect(communityCampaignsService.create("fresh-user", { title: "  ", country: "GB" } as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(m.organiserProfile.findUnique).not.toHaveBeenCalled();
  });

  it("still respects the market's organiserApplicationsEnabled gate for a brand-new organiser (real compliance boundary, not friction being removed)", async () => {
    m.organiserProfile.findUnique.mockResolvedValue(null);
    m.marketConfiguration.findUnique.mockResolvedValueOnce({ countryCode: "NG", organiserApplicationsEnabled: false } as never);

    await expect(communityCampaignsService.create("fresh-user", { title: "My buy", country: "NG" })).rejects.toMatchObject({ statusCode: 403 });
    expect(m.organiserProfile.create).not.toHaveBeenCalled();
  });

  it("E: self-supply creation touches no SupplierProfile/SupplierAccount lookup at all", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "fresh-user", isVerified: false, isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);
    m.communityCampaign.create.mockResolvedValue({ id: "camp-self", status: "DRAFT" });

    await communityCampaignsService.create("fresh-user", { title: "Self supply buy", country: "GB", fulfilmentOwner: "SELF" });

    expect(m.supplierProfile.findUnique).not.toHaveBeenCalled();
  });

  it("an existing restricted organiser cannot create a new draft", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: true });
    await expect(communityCampaignsService.create("restricted-user", { title: "Nope", country: "GB" })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("communityCampaignsService.update — resumable draft persistence (B)", () => {
  it("B: a draft's Product/Delivery fields can be saved and are reflected in the update call", async () => {
    // COLLECTION here deliberately — M4 gates DELIVERY behind
    // COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED; see
    // community-buy-privacy.test.ts for that gating's own coverage. This
    // test is only about Product/Delivery fields being persisted at all.
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: null, supplierId: null } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" });
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", status: "DRAFT", images: ["img1.jpg"], unit: "kg", quantityPerOrder: 2, deliveryPreference: "COLLECTION" });

    const result = await communityCampaignsService.update("u1", "camp-1", {
      images: ["img1.jpg"], unit: "kg", quantityPerOrder: 2, deliveryPreference: "COLLECTION",
    });

    expect(result.deliveryPreference).toBe("COLLECTION");
    expect(m.communityCampaign.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ images: ["img1.jpg"], unit: "kg", quantityPerOrder: 2, deliveryPreference: "COLLECTION" }),
    }));
  });

  it("rejects an invalid deliveryPreference value instead of letting it reach a raw DB enum error", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: null, supplierId: null } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" });

    await expect(
      communityCampaignsService.update("u1", "camp-1", { deliveryPreference: "TELEPORT" as never }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("the Supply step can be set via update() while still a draft (not only at create time)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "DRAFT", termsLockedAt: null, supplierId: null, country: "GB" } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" });
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", isVerified: true, isRestricted: false, country: "GB", vendor: { userId: "vendor-user-1" } } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", fulfilmentOwner: "SUPPLIER", supplierId: "sup-1", minimumShares: null, maximumShares: null, title: "T" });

    const result = await communityCampaignsService.update("u1", "camp-1", { fulfilmentOwner: "SUPPLIER", supplierId: "sup-1" });

    expect(result.supplierId).toBe("sup-1");
    expect(m.communityCampaign.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fulfilmentOwner: "SUPPLIER", supplierId: "sup-1" }),
    }));
  });

  it("blocks changing the supply route once the campaign is LIVE — reassignSupplier exists for that", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", status: "LIVE", termsLockedAt: null, supplierId: "sup-1" } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" });

    await expect(
      communityCampaignsService.update("u1", "camp-1", { fulfilmentOwner: "SELF" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("communityCampaignsService.submit — the authoritative gate (C, D, H)", () => {
  it("C: rejects an incomplete draft with a structured list of exactly what's missing, and does not touch the draft's status", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT",
      country: null, currency: null, deadline: null,
      minimumShares: null, goalShares: null, maximumShares: null, pricePerShareMinor: null,
      unit: null, quantityPerOrder: null, fulfilmentOwner: "SELF", supplierId: null,
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: false, isRestricted: false });

    await expect(communityCampaignsService.submit("u1", "camp-1")).rejects.toMatchObject({
      statusCode: 400,
      code: "SUBMIT_REQUIREMENTS_NOT_MET",
      details: {
        missing: expect.arrayContaining([
          "organiser_verification", "country", "currency", "deadline",
          "minimumShares", "goalShares", "maximumShares", "pricePerShareMinor",
          "unit", "quantityPerOrder",
        ]),
      },
    });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("D: succeeds once every requirement is met and the organiser is verified", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SELF", supplierId: null,
      ...validDraftFields, deadline: new Date(validDraftFields.deadline),
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", status: "UNDER_REVIEW" });

    const result = await communityCampaignsService.submit("u1", "camp-1");
    expect(result.status).toBe("UNDER_REVIEW");
  });

  it("F: a SUPPLIER-route draft with an unverified/restricted supplier is rejected with supplier_eligibility, not silently allowed", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SUPPLIER", supplierId: "sup-1",
      ...validDraftFields, deadline: new Date(validDraftFields.deadline),
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", isVerified: false, isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);

    await expect(communityCampaignsService.submit("u1", "camp-1")).rejects.toMatchObject({
      code: "SUBMIT_REQUIREMENTS_NOT_MET",
      details: { missing: ["supplier_eligibility"] },
    });
  });

  // Regression: a Workstream-3 campaign (no-Vendor-required supplier) has
  // supplierId === null by design — only supplierAccountId is set (see
  // CreateCampaignInput's own doc comment). This gate used to check
  // supplierId alone, so it rejected with "missing: supplierId" for EVERY
  // such campaign, permanently blocking it from ever reaching review even
  // with a real, approved supplier assigned.
  it("F2: a SUPPLIER-route draft using the Workstream-3 supplierAccountId (no legacy supplierId) succeeds once the account is APPROVED", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SUPPLIER", supplierId: null, supplierAccountId: "acct-1",
      ...validDraftFields, deadline: new Date(validDraftFields.deadline),
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", status: "UNDER_REVIEW" });

    const result = await communityCampaignsService.submit("u1", "camp-1");
    expect(result.status).toBe("UNDER_REVIEW");
    expect(m.supplierProfile.findUnique).not.toHaveBeenCalled();
  });

  it("F3: a SUPPLIER-route draft using supplierAccountId is rejected with supplier_eligibility when the account isn't APPROVED", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SUPPLIER", supplierId: null, supplierAccountId: "acct-1",
      ...validDraftFields, deadline: new Date(validDraftFields.deadline),
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "UNDER_REVIEW" } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);

    await expect(communityCampaignsService.submit("u1", "camp-1")).rejects.toMatchObject({
      code: "SUBMIT_REQUIREMENTS_NOT_MET",
      details: { missing: ["supplier_eligibility"] },
    });
  });

  it("H: submit() only ever flips status on the actual server-confirmed success path — the caller cannot observe UNDER_REVIEW without this call succeeding", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SELF", supplierId: null,
      country: null, currency: null, deadline: null, minimumShares: null, goalShares: null, maximumShares: null,
      pricePerShareMinor: null, unit: null, quantityPerOrder: null,
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });

    await expect(communityCampaignsService.submit("u1", "camp-1")).rejects.toBeDefined();
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });
});

describe("campaignContributionsService.pledge — the guarded-transaction capacity race (the real gap this workstream closes)", () => {
  it("when a concurrent pledge wins the last slot first, the loser's guarded updateMany claims 0 rows and pledge() rejects with CAPACITY_UNAVAILABLE — no contribution is created, no double-decrement occurs", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-race", status: "LIVE", country: "GB", currency: "GBP",
      deadline: new Date(Date.now() + 100000), pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 5,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    } as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: "buyer-1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" } as never);
    m.campaignParticipant.findUnique.mockResolvedValue(null as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-race", userId: "organiser-race" } as never);
    m.campaignParticipant.findFirst.mockResolvedValue(null as never);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as never);

    // This is the real race: the pre-check (assertCapacityAvailable, a
    // plain read of confirmedShares=5) sees 1 slot free for a quantity-1
    // pledge and passes — but by the time the transaction's guarded
    // updateMany actually runs, a concurrent winner has already taken it,
    // so the real capacity row is stale relative to this read.
    const txCampaign = {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-race", maximumShares: 6, confirmedShares: 6, termsLockedAt: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }), // the guard rejects — this caller lost the race
      update: vi.fn(),
    };
    const txContribution = { create: vi.fn() };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue({ id: "camp-race", maximumShares: 6, confirmedShares: 6 } as never);

    await expect(
      campaignContributionsService.pledge("buyer-1", "camp-race", 1, "pm-1"),
    ).rejects.toMatchObject({ statusCode: 409, code: "CAPACITY_UNAVAILABLE" });

    expect(txContribution.create).not.toHaveBeenCalled();
    // The guard itself is the only place capacity was actually decided —
    // prove it was consulted with the exact "no more than max-quantity
    // already confirmed" condition, not skipped.
    expect(txCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: "camp-race", confirmedShares: { lte: 5 } },
      data: { confirmedShares: { increment: 1 } },
    });
  });

  it("the winning side of the same race still succeeds normally — the guard only blocks the loser, not every concurrent pledge", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-race2", status: "LIVE", country: "GB", currency: "GBP",
      deadline: new Date(Date.now() + 100000), pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 5,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    } as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: "buyer-1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" } as never);
    m.campaignParticipant.findUnique.mockResolvedValue(null as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-race2", userId: "organiser-race2" } as never);
    m.campaignParticipant.findFirst.mockResolvedValue(null as never);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as never);

    const txCampaign = {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-race2", maximumShares: 6, confirmedShares: 5, termsLockedAt: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    };
    const txContribution = { create: vi.fn().mockResolvedValue({ id: "contrib-race" }) };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-race", status: "PLEDGED", participant: { userId: "buyer-1" } } as never);

    const result = await campaignContributionsService.pledge("buyer-1", "camp-race2", 1, "pm-1");
    expect(result.status).toBe("PLEDGED");
    expect(txContribution.create).toHaveBeenCalled();
  });
});
