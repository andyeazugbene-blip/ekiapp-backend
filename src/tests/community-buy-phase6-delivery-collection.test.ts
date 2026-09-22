/**
 * Phase 6 (delivery + collection/tracking) — focused tests for:
 *  - the real, organiser-set delivery fee (separate from the buyer 5% Eki
 *    fee, snapshotted at pledge time, charged once alongside it, refunded
 *    in full, excluded from supplier/organiser settlement math)
 *  - the collection code (generation, uniqueness/collision-retry, verify
 *    by supplier/organiser, single-use, negative privacy)
 *  - the DeliveryReference <-> CampaignFulfilment tracking wiring
 *    (dispatch bulk-updates, participant receipt confirms delivery,
 *    participant problem report flags an exception)
 * Mirrors the existing Prisma-mocked unit-test convention.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    organiserProfile: { findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    communityCampaign: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    campaignContribution: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    campaignParticipant: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    buyerPaymentMethod: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    deliveryReference: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    campaignFulfilment: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    campaignFulfilmentEvent: { create: vi.fn(), findFirst: vi.fn() },
    campaignChargeAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn() },
    campaignRefund: { create: vi.fn() },
    // Buyer-country eligibility gate (join()/pledge() — buyer-country.service.ts).
    user: { findUnique: vi.fn().mockResolvedValue({ country: "United Kingdom" }) },
    $transaction: vi.fn(),
  },
}));
vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() }, transfers: { create: vi.fn() } } }));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { trigger: vi.fn() } }));
vi.mock("../modules/community-buy/support-case.service", () => ({ supportCaseService: { create: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";
import { campaignFulfilmentService } from "../modules/community-buy/campaign-fulfilment.service";
import { createDeliveryReferenceForContribution } from "../modules/community-buy/community-buy-privacy.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.campaignFulfilment.updateMany.mockResolvedValue({ count: 1 } as never);
  m.campaignFulfilmentEvent.create.mockResolvedValue({} as never);
  m.campaignFulfilmentEvent.findFirst.mockResolvedValue(null);
  m.deliveryReference.updateMany.mockResolvedValue({ count: 0 } as never);
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

// ─────────────────────────── Delivery fee ───────────────────────────

describe("communityCampaignsService.submit — delivery fee requirement", () => {
  it("rejects a DELIVERY campaign with no delivery fee set", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SELF", supplierId: null,
      ...validDraftFields, deadline: new Date(validDraftFields.deadline),
      deliveryPreference: "DELIVERY", deliveryCoverageAreas: ["SW1"], deliveryFeeAmountMinor: null,
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);

    await expect(communityCampaignsService.submit("u1", "camp-1")).rejects.toMatchObject({
      code: "SUBMIT_REQUIREMENTS_NOT_MET",
      details: { missing: expect.arrayContaining(["deliveryFeeAmountMinor"]) },
    });
  });

  it("accepts a DELIVERY campaign with an explicit free-delivery fee of 0", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SELF", supplierId: null,
      ...validDraftFields, deadline: new Date(validDraftFields.deadline),
      deliveryPreference: "DELIVERY", deliveryCoverageAreas: ["SW1"], deliveryFeeAmountMinor: 0,
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", status: "UNDER_REVIEW" } as never);

    const result = await communityCampaignsService.submit("u1", "camp-1");
    expect(result.status).toBe("UNDER_REVIEW");
  });

  it("never requires a delivery fee for a COLLECTION campaign", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "DRAFT", fulfilmentOwner: "SELF", supplierId: null,
      ...validDraftFields, deadline: new Date(validDraftFields.deadline),
      deliveryPreference: "COLLECTION", collectionAddressLine1: "1 High St", collectionCity: "London", collectionPostcode: "SW1A 1AA",
      deliveryFeeAmountMinor: null,
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", isVerified: true, isRestricted: false });
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", status: "UNDER_REVIEW" } as never);

    const result = await communityCampaignsService.submit("u1", "camp-1");
    expect(result.status).toBe("UNDER_REVIEW");
  });
});

describe("communityCampaignsService.create/update — delivery fee validation", () => {
  it("rejects a negative delivery fee at create()", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);

    await expect(
      communityCampaignsService.create("u1", { title: "Rice", country: "GB", deliveryFeeAmountMinor: -50 } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("blocks changing the delivery fee once financial terms are locked (a pledge already exists)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "LIVE", termsLockedAt: new Date(), fulfilmentOwner: "SELF",
    } as never);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" } as never);

    await expect(
      communityCampaignsService.update("u1", "camp-1", { deliveryFeeAmountMinor: 300 } as never),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("campaignContributionsService.pledge — delivery fee snapshot", () => {
  it("snapshots the campaign's delivery fee onto the contribution for a DELIVERY campaign", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-20", status: "LIVE", country: "GB", currency: "GBP", deadline: new Date(Date.now() + 100000),
      pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
      deliveryPreference: "DELIVERY", deliveryFeeAmountMinor: 350, deliveryCoverageAreas: ["SW1"],
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    } as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: "buyer-1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" } as never);
    m.campaignParticipant.findFirst.mockResolvedValue(null);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as never);

    const txCampaign = { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-20", maximumShares: 6, confirmedShares: 0, termsLockedAt: null }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() };
    const txContribution = { create: vi.fn().mockResolvedValue({ id: "contrib-20" }) };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-20", status: "PLEDGED", participant: { userId: "buyer-1" } } as never);

    const deliveryAddress = { recipientName: "Ada", addressLine1: "1 SW1 St", city: "London", postcode: "SW1A 1AA" };
    await campaignContributionsService.pledge("buyer-1", "camp-20", 1, "pm-1", deliveryAddress);

    expect(txContribution.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryFeeAmountMinor: 350, amount: 1000 }) }),
    );
  });

  it("snapshots a delivery fee of 0 for a COLLECTION campaign, regardless of the campaign's own deliveryFeeAmountMinor", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-21", status: "LIVE", country: "GB", currency: "GBP", deadline: new Date(Date.now() + 100000),
      pricePerShareMinor: 1000, maximumShares: 6, confirmedShares: 0,
      deliveryPreference: "COLLECTION", deliveryFeeAmountMinor: 999,
    } as never);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
      buyerServiceFeeBps: 500, buyerServiceFeeMinAmount: 120, buyerServiceFeeMaxAmount: 500,
    } as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: "buyer-1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" } as never);
    m.campaignParticipant.findFirst.mockResolvedValue(null);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as never);

    const txCampaign = { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "camp-21", maximumShares: 6, confirmedShares: 0, termsLockedAt: null }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() };
    const txContribution = { create: vi.fn().mockResolvedValue({ id: "contrib-21" }) };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ communityCampaign: txCampaign, campaignContribution: txContribution }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-21", status: "PLEDGED", participant: { userId: "buyer-1" } } as never);

    await campaignContributionsService.pledge("buyer-1", "camp-21", 1, "pm-1");

    expect(txContribution.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryFeeAmountMinor: 0 }) }),
    );
  });
});

describe("campaignContributionsService.attemptCharge — delivery fee is charged once, alongside the buyer fee", () => {
  it("includes the delivery fee in the single off-session PaymentIntent amount — never a second charge", async () => {
    m.campaignContribution.findUniqueOrThrow.mockResolvedValueOnce({
      id: "contrib-30", campaignId: "camp-20", quantity: 2, status: "PLEDGED", currency: "GBP",
      amount: 2000, buyerServiceFeeAmount: 100, deliveryFeeAmountMinor: 350,
      participant: { userId: "buyer-1" },
      paymentMethod: { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" },
    } as never);
    m.campaignContribution.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.campaignChargeAttempt.count.mockResolvedValueOnce(0 as never);
    m.campaignChargeAttempt.create.mockResolvedValueOnce({ id: "attempt-1" } as never);
    m.campaignChargeAttempt.update.mockResolvedValue({} as never);
    vi.mocked(stripe.paymentIntents.create).mockResolvedValueOnce({ id: "pi_delivery_1", status: "succeeded" } as never);

    await campaignContributionsService.attemptCharge("contrib-30");

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2450 }), // 2000 + 100 + 350, one call
      expect.anything(),
    );
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });
});

describe("communityCampaignsService.createRefundRecordsForFailedCampaign — refunds the full charged amount", () => {
  it("includes the delivery fee in the refund amount, matching what was actually charged", async () => {
    m.campaignContribution.findMany.mockResolvedValueOnce([
      { id: "contrib-captured", campaignId: "camp-1", amount: 5000, buyerServiceFeeAmount: 200, deliveryFeeAmountMinor: 350, currency: "GBP" },
    ] as never);
    m.campaignRefund.create.mockResolvedValue({} as never);

    const created = await communityCampaignsService.createRefundRecordsForFailedCampaign("camp-1");

    expect(created).toBe(1);
    expect(m.campaignRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contributionId: "contrib-captured", amount: 5550 }) }),
    );
  });
});

// ─────────────────────────── Collection code ───────────────────────────

describe("createDeliveryReferenceForContribution — collection code generation", () => {
  it("generates a collection code for a COLLECTION-method contribution", async () => {
    m.campaignContribution.findUnique.mockResolvedValueOnce({ campaignId: "camp-1", participantId: "part-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({ deliveryPreference: "COLLECTION" } as never);
    m.deliveryReference.findUnique.mockResolvedValueOnce(null); // no collision
    m.deliveryReference.upsert.mockResolvedValue({} as never);

    await createDeliveryReferenceForContribution("contrib-1");

    expect(m.deliveryReference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "NOT_REQUIRED",
          collectionCode: expect.stringMatching(/^\d{6}$/),
        }),
      }),
    );
  });

  it("leaves collectionCode null for a DELIVERY-method contribution", async () => {
    m.campaignContribution.findUnique.mockResolvedValueOnce({ campaignId: "camp-2", participantId: "part-2" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({ deliveryPreference: "DELIVERY" } as never);
    m.deliveryReference.upsert.mockResolvedValue({} as never);

    await createDeliveryReferenceForContribution("contrib-2");

    expect(m.deliveryReference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "PENDING", collectionCode: null }) }),
    );
    expect(m.deliveryReference.findUnique).not.toHaveBeenCalled();
  });

  it("retries on a collision and still lands a unique code", async () => {
    m.campaignContribution.findUnique.mockResolvedValueOnce({ campaignId: "camp-3", participantId: "part-3" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({ deliveryPreference: "COLLECTION" } as never);
    m.deliveryReference.findUnique
      .mockResolvedValueOnce({ id: "existing" } as never) // first candidate clashes
      .mockResolvedValueOnce(null); // second candidate is free
    m.deliveryReference.upsert.mockResolvedValue({} as never);

    await createDeliveryReferenceForContribution("contrib-3");

    expect(m.deliveryReference.findUnique).toHaveBeenCalledTimes(2);
    expect(m.deliveryReference.upsert).toHaveBeenCalled();
  });

  it("never throws out of the surrounding capture flow even if generation fails (never-throws contract)", async () => {
    m.campaignContribution.findUnique.mockResolvedValueOnce({ campaignId: "camp-4", participantId: "part-4" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({ deliveryPreference: "COLLECTION" } as never);
    m.deliveryReference.findUnique.mockResolvedValue({ id: "always-clashes" } as never); // never resolves a free code

    await expect(createDeliveryReferenceForContribution("contrib-4")).resolves.toBeUndefined();
    expect(m.deliveryReference.upsert).not.toHaveBeenCalled();
  });
});

describe("campaignFulfilmentService.verifyCollectionCodeForVendor — physical handover", () => {
  function ownedBySupplier() {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "vendor-user-1" } } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1", organiserId: "org-1", fulfilmentOwner: "SUPPLIER" } as never);
    m.campaignFulfilment.findUnique.mockResolvedValue({ campaignId: "camp-1", status: "READY_FOR_DISPATCH_OR_COLLECTION" } as never);
  }

  it("verifies a correct, unredeemed code — single-use claim, status flips to COLLECTED, event recorded", async () => {
    ownedBySupplier();
    m.deliveryReference.findUnique.mockResolvedValue({ id: "dr-1", contributionId: "contrib-1", collectionCodeRedeemedAt: null } as never);
    m.deliveryReference.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await campaignFulfilmentService.verifyCollectionCodeForVendor("vendor-1", "camp-1", "482913");

    expect(result).toEqual({ verified: true, contributionId: "contrib-1" });
    expect(m.deliveryReference.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "dr-1", collectionCodeRedeemedAt: null }, data: expect.objectContaining({ status: "COLLECTED", collectionCodeRedeemedByUserId: "vendor-user-1" }) }),
    );
    expect(m.campaignFulfilmentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: "COLLECTED", contributionId: "contrib-1", actorRole: "SUPPLIER" }) }),
    );
  });

  it("rejects an unknown code with a generic message — never reveals it was wrong vs. not found", async () => {
    ownedBySupplier();
    m.deliveryReference.findUnique.mockResolvedValue(null);

    await expect(
      campaignFulfilmentService.verifyCollectionCodeForVendor("vendor-1", "camp-1", "000000"),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_COLLECTION_CODE" });
    expect(m.deliveryReference.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an already-redeemed code with the same generic message — never a duplicate collection", async () => {
    ownedBySupplier();
    m.deliveryReference.findUnique.mockResolvedValue({ id: "dr-1", contributionId: "contrib-1", collectionCodeRedeemedAt: new Date() } as never);

    await expect(
      campaignFulfilmentService.verifyCollectionCodeForVendor("vendor-1", "camp-1", "482913"),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_COLLECTION_CODE" });
    expect(m.deliveryReference.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when the atomic claim loses a race to a concurrent verify — never double-collects", async () => {
    ownedBySupplier();
    m.deliveryReference.findUnique.mockResolvedValue({ id: "dr-1", contributionId: "contrib-1", collectionCodeRedeemedAt: null } as never);
    m.deliveryReference.updateMany.mockResolvedValue({ count: 0 } as never); // another verify already claimed it

    await expect(
      campaignFulfilmentService.verifyCollectionCodeForVendor("vendor-1", "camp-1", "482913"),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_COLLECTION_CODE" });
    expect(m.campaignFulfilmentEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a supplier who doesn't own this campaign before ever looking up a code", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "vendor-user-1" } } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "someone-else" } as never);

    await expect(
      campaignFulfilmentService.verifyCollectionCodeForVendor("vendor-1", "camp-1", "482913"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(m.deliveryReference.findUnique).not.toHaveBeenCalled();
  });
});

describe("campaignFulfilmentService.verifyCollectionCodeForOrganiser — self-fulfilled campaigns", () => {
  it("allows the organiser to verify collection for their own self-fulfilled campaign", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-5", organiserId: "org-1", fulfilmentOwner: "SELF" } as never);
    m.deliveryReference.findUnique.mockResolvedValue({ id: "dr-5", contributionId: "contrib-5", collectionCodeRedeemedAt: null } as never);
    m.deliveryReference.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await campaignFulfilmentService.verifyCollectionCodeForOrganiser("organiser-user-1", "camp-5", "111222");

    expect(result).toEqual({ verified: true, contributionId: "contrib-5" });
    expect(m.campaignFulfilmentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorRole: "ORGANISER" }) }),
    );
  });

  it("rejects the organiser verifying collection on a campaign that has an assigned supplier — not their job", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-6", organiserId: "org-1", fulfilmentOwner: "SUPPLIER" } as never);

    await expect(
      campaignFulfilmentService.verifyCollectionCodeForOrganiser("organiser-user-1", "camp-6", "111222"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(m.deliveryReference.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an organiser who doesn't own the campaign — never leaks whether it has a fulfilment record", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-7", organiserId: "someone-else" } as never);

    await expect(
      campaignFulfilmentService.verifyCollectionCodeForOrganiser("organiser-user-1", "camp-7", "111222"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("campaignFulfilmentService.getMyDeliveryReference — negative privacy", () => {
  function ownParticipant() {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst = vi.fn().mockResolvedValue({ id: "contrib-1" });
  }

  it("returns the collection code while it's still unredeemed", async () => {
    ownParticipant();
    m.deliveryReference.findUnique.mockResolvedValue({
      deliveryMethod: "COLLECTION", status: "NOT_REQUIRED", collectionCode: "482913", collectionCodeRedeemedAt: null,
    } as never);

    const result = await campaignFulfilmentService.getMyDeliveryReference("buyer-1", "camp-1");
    expect(result?.collectionCode).toBe("482913");
  });

  it("never shows a code that has already been redeemed", async () => {
    ownParticipant();
    m.deliveryReference.findUnique.mockResolvedValue({
      deliveryMethod: "COLLECTION", status: "COLLECTED", collectionCode: "482913", collectionCodeRedeemedAt: new Date(),
    } as never);

    const result = await campaignFulfilmentService.getMyDeliveryReference("buyer-1", "camp-1");
    expect(result?.collectionCode).toBeNull();
  });

  it("throws for a user with no captured (PAID) contribution on this campaign — never fabricates someone else's reference", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-2" } as never);
    m.campaignContribution.findFirst = vi.fn().mockResolvedValue(null);

    await expect(campaignFulfilmentService.getMyDeliveryReference("buyer-2", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.deliveryReference.findUnique).not.toHaveBeenCalled();
  });
});

// ─────────────────────── Delivery tracking wiring ───────────────────────

describe("campaignFulfilmentService.markDispatched — bulk delivery-tracking wiring", () => {
  it("hands every pending DELIVERY-method participant's order to the courier when the campaign is dispatched", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "vendor-user-1" } } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1", organiserId: "org-1", title: "Rice", organiser: { userId: "organiser-user-1" }, participants: [] } as never);
    m.campaignFulfilment.findUnique.mockResolvedValue({ campaignId: "camp-1", status: "READY_FOR_DISPATCH_OR_COLLECTION", method: "DELIVERY" } as never);
    m.campaignFulfilment.updateMany.mockResolvedValue({ count: 1 } as never);
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ campaignId: "camp-1", status: "DISPATCHED", method: "DELIVERY" } as never);

    await campaignFulfilmentService.markDispatched("vendor-1", "camp-1");

    expect(m.deliveryReference.updateMany).toHaveBeenCalledWith({
      where: { campaignId: "camp-1", deliveryMethod: "DELIVERY", status: "PENDING" },
      data: { status: "HANDED_TO_COURIER" },
    });
  });
});

describe("campaignFulfilmentService.confirmReceiptForParticipant — receipt confirmation is the delivered signal", () => {
  it("marks the participant's own DELIVERY-method reference DELIVERED", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst = vi.fn().mockResolvedValue({ id: "contrib-1" });
    m.campaignFulfilmentEvent.findFirst.mockResolvedValue(null);

    await campaignFulfilmentService.confirmReceiptForParticipant("buyer-1", "camp-1");

    expect(m.deliveryReference.updateMany).toHaveBeenCalledWith({
      where: { contributionId: "contrib-1", deliveryMethod: "DELIVERY", status: { not: "DELIVERED" } },
      data: { status: "DELIVERED" },
    });
  });

  it("is idempotent — a repeat confirmation is a harmless no-op, not a second event", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst = vi.fn().mockResolvedValue({ id: "contrib-1" });
    m.campaignFulfilmentEvent.findFirst.mockResolvedValue({ id: "already-confirmed" } as never);

    const result = await campaignFulfilmentService.confirmReceiptForParticipant("buyer-1", "camp-1");

    expect(result).toEqual({ confirmed: true });
    expect(m.campaignFulfilmentEvent.create).not.toHaveBeenCalled();
    expect(m.deliveryReference.updateMany).not.toHaveBeenCalled();
  });
});

describe("campaignFulfilmentService.reportFulfilmentProblem — flags the participant's own reference as an exception", () => {
  it("marks the participant's own reference EXCEPTION unless it's already terminal", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst = vi.fn().mockResolvedValue({ id: "contrib-1" });
    const { supportCaseService } = await import("../modules/community-buy/support-case.service");
    vi.mocked(supportCaseService.create).mockResolvedValue({ id: "case-1" } as never);

    await campaignFulfilmentService.reportFulfilmentProblem("buyer-1", "camp-1", "Never arrived");

    expect(m.deliveryReference.updateMany).toHaveBeenCalledWith({
      where: { contributionId: "contrib-1", status: { notIn: ["DELIVERED", "COLLECTED", "REVOKED"] } },
      data: { status: "EXCEPTION" },
    });
  });
});
