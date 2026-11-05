/**
 * Phase 1 acceptance rules that live on the server: offers and campaigns
 * validated here rather than on screen, one review record per subject, and
 * separation of duties in the Approvals queue.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  account: { findUnique: vi.fn() },
  offer: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  campaign: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
  review: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  user: { findUnique: vi.fn() },
  grant: { findUnique: vi.fn(), upsert: vi.fn() },
  supportCase: { count: vi.fn() },
  create: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  publish: vi.fn(),
  owned: vi.fn(),
  isTest: vi.fn(),
  notify: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    supplierAccount: m.account,
    supplierOffer: m.offer,
    communityCampaign: m.campaign,
    reviewRequest: m.review,
    user: m.user,
    capabilityGrant: m.grant,
    communityBuySupportCase: m.supportCase,
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({ reviewRequest: m.review, supplierOffer: m.offer }),
  },
}));
vi.mock("../shared/test-accounts", () => ({ viewerIsTest: m.isTest }));
vi.mock("../shared/utils/audit", () => ({ recordAudit: m.audit }));
vi.mock("../modules/community-buy/community-buy-notices", () => ({ notifyUserInAppAndEmail: m.notify }));
vi.mock("../modules/community-buy/market-configuration.service", () => ({ marketConfigurationService: { get: vi.fn() } }));
vi.mock("../modules/community-buy/supplier-account.service", () => ({
  isSupplierPayoutReady: () => true,
  supplierAccountService: { approve: vi.fn(), reject: vi.fn() },
}));
vi.mock("../modules/community-buy/community-campaigns.service", () => ({
  communityCampaignsService: {
    create: m.create,
    submit: m.submit,
    approve: m.approve,
    publish: m.publish,
    requireOwnedByOrganiserForWrite: m.owned,
  },
}));

import { Prisma } from "@prisma/client";

import { reviewRequestsService } from "../modules/community-buy/review-requests.service";
import { supplierOffersService } from "../modules/community-buy/supplier-offers.service";

const VALID = {
  foodstuffName: "Puna yam",
  packSize: "10kg",
  pricePerShareMinor: 4000,
  minimumShares: 3,
  maximumShares: 6,
  windowStartsAt: "2026-11-10T00:00:00.000Z",
  windowEndsAt: "2030-01-01T00:00:00.000Z",
  fulfilmentMethods: ["COLLECTION"],
  collectionAddressLine1: "1 Market St",
  collectionCity: "Coventry",
  collectionPostcode: "CV1 1AA",
};

const OFFER = {
  id: "offer-1", status: "APPROVED", supplierAccountId: "acc-1", market: "GB", currency: "GBP", version: 1,
  foodstuffName: "Puna yam", description: null, images: [], packSize: "10kg", pricePerShareMinor: 4000,
  minimumShares: 3, maximumShares: 6, windowEndsAt: new Date("2030-01-01"), fulfilmentMethods: ["COLLECTION"],
  deliveryAreas: [], deliveryFeeMinor: null, collectionAddressLine1: "1 Market St", collectionCity: "Coventry", collectionPostcode: "CV1 1AA",
  supplierAccount: { userId: "supplier-user", supplierState: "APPROVED", businessName: "Ade Foods" },
};

beforeEach(() => {
  vi.resetAllMocks();
  m.isTest.mockResolvedValue(false);
  m.account.findUnique.mockResolvedValue({ id: "acc-1", userId: "supplier-user", supplierState: "APPROVED" });
});

describe("supplier offer validation is on the server", () => {
  it.each([
    ["no price", { pricePerShareMinor: 0 }],
    ["minimum below 1", { minimumShares: 0 }],
    ["maximum below minimum", { maximumShares: 2 }],
    ["window ending before it starts", { windowEndsAt: "2026-01-01T00:00:00.000Z" }],
    ["no delivery or collection", { fulfilmentMethods: [] }],
    ["collection with no address", { collectionAddressLine1: "" }],
  ])("refuses an offer with %s", async (_label, change) => {
    await expect(supplierOffersService.createDraft("supplier-user", { ...VALID, ...change })).rejects.toMatchObject({ statusCode: 400, code: "OFFER_INVALID" });
    expect(m.offer.create).not.toHaveBeenCalled();
  });

  it("saves a valid offer as a draft, in the UK, in pounds", async () => {
    m.offer.create.mockResolvedValue({ id: "offer-1" });
    await supplierOffersService.createDraft("supplier-user", VALID);
    expect(m.offer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "DRAFT", market: "GB", currency: "GBP", supplierAccountId: "acc-1" }) });
  });
});

describe("submitting creates the record before anything says in review", () => {
  it("opens an offer request, plus eligibility the first time", async () => {
    m.offer.findUnique.mockResolvedValue({ ...OFFER, status: "DRAFT" });
    m.account.findUnique.mockResolvedValue({ id: "acc-1", userId: "supplier-user", supplierState: "UNDER_REVIEW" });
    m.review.create.mockResolvedValue({ id: "req" });
    m.offer.update.mockResolvedValue({ id: "offer-1", status: "IN_REVIEW" });

    await supplierOffersService.submit("supplier-user", "offer-1");

    expect(m.review.create.mock.calls.map(([arg]) => arg.data.type)).toEqual(["SUPPLIER_ELIGIBILITY", "SUPPLIER_OFFER"]);
  });

  it("asks for eligibility only once", async () => {
    m.offer.findUnique.mockResolvedValue({ ...OFFER, status: "DRAFT" });
    m.review.create.mockResolvedValue({ id: "req" });
    m.offer.update.mockResolvedValue({ id: "offer-1" });

    await supplierOffersService.submit("supplier-user", "offer-1");

    expect(m.review.create.mock.calls.map(([arg]) => arg.data.type)).toEqual(["SUPPLIER_OFFER"]);
  });

  it("a double tap resolves to the existing request, not a second one", async () => {
    m.review.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    m.review.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "existing" });

    const result = await reviewRequestsService.open({ type: "SUPPLIER_OFFER", subjectType: "SupplierOffer", subjectId: "offer-1", market: "GB", submittedById: "u" });

    expect(result).toEqual({ id: "existing" });
  });

  it("fixing what the admin asked for puts the same request back in the queue", async () => {
    m.review.findFirst.mockResolvedValue({ id: "existing", status: "INFO_REQUIRED" });
    m.review.update.mockResolvedValue({ id: "existing", status: "SUBMITTED" });

    await reviewRequestsService.open({ type: "SUPPLIER_OFFER", subjectType: "SupplierOffer", subjectId: "offer-1", market: "GB", submittedById: "u" });

    expect(m.review.create).not.toHaveBeenCalled();
    expect(m.review.update).toHaveBeenCalledWith({ where: { id: "existing" }, data: expect.objectContaining({ status: "SUBMITTED", infoMessage: null }) });
  });

  it("resubmitting something already in review changes nothing", async () => {
    m.offer.findUnique.mockResolvedValue({ ...OFFER, status: "IN_REVIEW" });
    m.review.findFirst.mockResolvedValue({ id: "existing" });

    await supplierOffersService.submit("supplier-user", "offer-1");

    expect(m.review.create).not.toHaveBeenCalled();
  });
});

describe("an offer in use can't change", () => {
  it("refuses a price change while a campaign uses it", async () => {
    m.offer.findUnique.mockResolvedValue(OFFER);
    m.campaign.count.mockResolvedValue(1);
    await expect(supplierOffersService.update("supplier-user", "offer-1", VALID)).rejects.toMatchObject({ code: "OFFER_IN_USE" });
  });

  it("creates a new version otherwise", async () => {
    m.offer.findUnique.mockResolvedValue(OFFER);
    m.campaign.count.mockResolvedValue(0);
    m.offer.create.mockResolvedValue({ id: "offer-2" });

    await supplierOffersService.update("supplier-user", "offer-1", VALID);

    expect(m.offer.update).toHaveBeenCalledWith({ where: { id: "offer-1" }, data: { status: "SUPERSEDED" } });
    expect(m.offer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ version: 2, previousVersionId: "offer-1", status: "DRAFT" }) });
  });

  it("someone else can't touch the offer", async () => {
    m.offer.findUnique.mockResolvedValue(OFFER);
    await expect(supplierOffersService.update("intruder", "offer-1", VALID)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("organiser limits come from the offer", () => {
  beforeEach(() => {
    m.offer.findUnique.mockResolvedValue(OFFER);
    m.create.mockResolvedValue({ id: "camp-1" });
    m.campaign.update.mockResolvedValue({ id: "camp-1" });
  });

  it.each([
    ["goal below the minimum", { goalShares: 2 }],
    ["goal above the maximum", { goalShares: 7 }],
    ["deadline after the offer window", { deadline: "2031-01-01T00:00:00.000Z" }],
    ["deadline in the past", { deadline: "2020-01-01T00:00:00.000Z" }],
    ["delivery the offer doesn't include", { fulfilmentMethod: "DELIVERY" }],
  ])("refuses %s", async (_label, change) => {
    await expect(supplierOffersService.createCampaignDraft("organiser", { offerId: "offer-1", ...change })).rejects.toMatchObject({ code: "CAMPAIGN_OUTSIDE_OFFER_LIMITS" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("takes price and quantities from the offer, and ignores anything the organiser sends", async () => {
    await supplierOffersService.createCampaignDraft("organiser", { offerId: "offer-1", goalShares: 5, pricePerShareMinor: 1, minimumShares: 1 } as never);
    expect(m.create).toHaveBeenCalledWith("organiser", expect.objectContaining({ pricePerShareMinor: 4000, minimumShares: 3, maximumShares: 6, goalShares: 5, fromApprovedOffer: true }));
  });

  it("an unapproved offer is never available", async () => {
    m.offer.findUnique.mockResolvedValue({ ...OFFER, status: "IN_REVIEW" });
    await expect(supplierOffersService.createCampaignDraft("organiser", { offerId: "offer-1" })).rejects.toMatchObject({ code: "OFFER_NOT_AVAILABLE" });
  });

  it("a demo organiser can't build on a real supplier's offer", async () => {
    m.isTest.mockImplementation(async (id: string) => id === "demo");
    await expect(supplierOffersService.createCampaignDraft("demo", { offerId: "offer-1" })).rejects.toMatchObject({ code: "OFFER_NOT_AVAILABLE" });
  });
});

describe("organiser checks and approval", () => {
  const CAMPAIGN = { id: "camp-1", status: "DRAFT", supplierOfferId: "offer-1", country: "GB", organiserId: "org-1", confirmedShares: 0 };

  beforeEach(() => {
    m.owned.mockResolvedValue(CAMPAIGN);
    m.user.findUnique.mockResolvedValue({ emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() });
    m.review.create.mockResolvedValue({ id: "req-1" });
    m.campaign.findUnique.mockResolvedValue({ ...CAMPAIGN, status: "UNDER_REVIEW", goalShares: 5, deadline: new Date("2029-01-01"), deliveryPreference: "COLLECTION", title: "Coventry yam", description: null, organiser: { isRestricted: false }, supplierOffer: OFFER });
  });

  it("asks only for what's missing, and keeps the draft", async () => {
    m.user.findUnique.mockResolvedValue({ emailVerifiedAt: new Date(), phoneVerifiedAt: null });
    await expect(supplierOffersService.submitCampaign("organiser", "camp-1")).rejects.toMatchObject({
      code: "ORGANISER_CHECKS_MISSING",
      details: { missing: ["phone"] },
    });
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("a first campaign goes to manual review", async () => {
    m.campaign.count.mockResolvedValue(0);
    m.grant.findUnique.mockResolvedValue(null);

    const result = await supplierOffersService.submitCampaign("organiser", "camp-1");

    expect(result.outcome).toBe("IN_REVIEW");
    expect(m.approve).not.toHaveBeenCalled();
    expect(m.review.create.mock.calls[0][0].data.type).toBe("COMMUNITY_BUY_CAMPAIGN");
  });

  it("a later campaign auto-approves when every condition holds", async () => {
    m.campaign.count.mockResolvedValue(1);
    m.grant.findUnique.mockResolvedValue({ status: "ACTIVE" });
    m.supportCase.count.mockResolvedValue(0);
    m.publish.mockResolvedValue({ id: "camp-1", status: "LIVE" });
    m.review.create.mockResolvedValue({ id: "req-2", autoApproved: true });

    const result = await supplierOffersService.submitCampaign("organiser", "camp-1");

    expect(result.outcome).toBe("LIVE");
    expect(m.review.create.mock.calls[0][0].data).toMatchObject({ status: "APPROVED", autoApproved: true });
  });

  it.each([
    ["an open dispute", () => m.supportCase.count.mockResolvedValue(1)],
    ["wording that fails the content check", () => m.campaign.findUnique.mockResolvedValue({ ...CAMPAIGN, goalShares: 5, deadline: new Date("2029-01-01"), deliveryPreference: "COLLECTION", title: "Guaranteed savings", description: null, organiser: { isRestricted: false }, supplierOffer: OFFER })],
    ["a goal outside the offer", () => m.campaign.findUnique.mockResolvedValue({ ...CAMPAIGN, goalShares: 99, deadline: new Date("2029-01-01"), deliveryPreference: "COLLECTION", title: "Fine", description: null, organiser: { isRestricted: false }, supplierOffer: OFFER })],
  ])("%s means manual review", async (_label, arrange) => {
    m.campaign.count.mockResolvedValue(1);
    m.grant.findUnique.mockResolvedValue({ status: "ACTIVE" });
    m.supportCase.count.mockResolvedValue(0);
    arrange();

    const result = await supplierOffersService.submitCampaign("organiser", "camp-1");

    expect(result.outcome).toBe("IN_REVIEW");
    expect(m.approve).not.toHaveBeenCalled();
  });

  it("can be withdrawn until someone joins", async () => {
    m.owned.mockResolvedValue({ ...CAMPAIGN, status: "LIVE", confirmedShares: 1 });
    await expect(supplierOffersService.withdrawCampaign("organiser", "camp-1")).rejects.toMatchObject({ code: "CAMPAIGN_HAS_PARTICIPANTS" });
  });
});

describe("Approvals queue", () => {
  const REQUEST = { id: "req-1", type: "SUPPLIER_OFFER", subjectType: "SupplierOffer", subjectId: "offer-1", market: "GB", status: "UNDER_REVIEW", submittedById: "supplier-user" };

  beforeEach(() => {
    m.review.findUnique.mockResolvedValue(REQUEST);
    m.review.update.mockResolvedValue(REQUEST);
    m.offer.findUnique.mockResolvedValue(OFFER);
  });

  it("an admin can't approve their own request", async () => {
    await expect(reviewRequestsService.approve("req-1", "supplier-user")).rejects.toMatchObject({ statusCode: 403, code: "REVIEW_SEPARATION_OF_DUTIES" });
  });

  it("an admin can't approve for a business they own", async () => {
    m.review.findUnique.mockResolvedValue({ ...REQUEST, submittedById: "someone-else" });
    await expect(reviewRequestsService.approve("req-1", "supplier-user")).rejects.toMatchObject({ code: "REVIEW_SEPARATION_OF_DUTIES" });
  });

  it("approving updates the offer, audits, and sends the required message", async () => {
    await reviewRequestsService.approve("req-1", "admin");
    expect(m.offer.update).toHaveBeenCalledWith({ where: { id: "offer-1" }, data: expect.objectContaining({ status: "APPROVED" }) });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "review_request.approved", actorId: "admin" }));
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Your bulk offer for Puna yam is live. Organisers can now build Community Buys on it." }));
  });

  it("an offer can't be approved before its supplier is eligible", async () => {
    m.offer.findUnique.mockResolvedValue({ ...OFFER, supplierAccount: { ...OFFER.supplierAccount, supplierState: "UNDER_REVIEW" } });
    await expect(reviewRequestsService.approve("req-1", "admin")).rejects.toMatchObject({ code: "SUPPLIER_NOT_ELIGIBLE" });
    expect(m.review.update).not.toHaveBeenCalled();
  });

  it("rejecting needs a listed reason, keeps the offer, and says why", async () => {
    await expect(reviewRequestsService.reject("req-1", "admin", "because")).rejects.toMatchObject({ code: "REJECTION_REASON_REQUIRED" });
    await reviewRequestsService.reject("req-1", "admin", "Wording needs changing", "Remove the savings claim");
    expect(m.offer.update).toHaveBeenCalledWith({ where: { id: "offer-1" }, data: { status: "REJECTED" } });
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Puna yam wasn't approved: Wording needs changing: Remove the savings claim. You can edit and resubmit." }));
  });

  it("a decided request can't be decided again", async () => {
    m.review.findUnique.mockResolvedValue({ ...REQUEST, status: "APPROVED" });
    await expect(reviewRequestsService.approve("req-1", "admin")).rejects.toMatchObject({ code: "REVIEW_ALREADY_DECIDED" });
  });
});
