import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { currencyFromCountry } from "../../shared/currency";
import { viewerIsTest } from "../../shared/test-accounts";
import { communityCampaignsService } from "./community-campaigns.service";
import { marketConfigurationService } from "./market-configuration.service";
import { isUniqueViolation, notifyOfferCampaignLive, reviewRequestsService } from "./review-requests.service";
import { isSupplierPayoutReady } from "./supplier-account.service";
import { notifyUserInAppAndEmail } from "./community-buy-notices";

const V1_MARKET = "GB";
const AUTO_APPROVAL_ACTOR = "system:auto-approval";
const FULFILMENT_METHODS = ["DELIVERY", "COLLECTION"];

// Phase 1 copy rules: wording a campaign name or update must never use.
const BANNED_CAMPAIGN_WORDS = /\b(escrow|guarantee[ds]?|protected|safeguarded|visa|immigration|income|investment)\b/i;

export type SupplierOfferInput = {
  foodstuffName?: string;
  description?: string;
  packSize?: string;
  weightGrams?: number;
  images?: string[];
  pricePerShareMinor?: number;
  minimumShares?: number;
  maximumShares?: number;
  windowStartsAt?: string;
  windowEndsAt?: string;
  fulfilmentMethods?: string[];
  deliveryAreas?: string[];
  deliveryFeeMinor?: number;
  collectionAddressLine1?: string;
  collectionCity?: string;
  collectionPostcode?: string;
  leadTimeDays?: number;
};

export type OfferCampaignInput = {
  offerId: string;
  groupName?: string;
  goalShares?: number;
  deadline?: string;
  fulfilmentMethod?: string;
};

function assertPositiveInt(value: unknown, message: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new AppError(message, 400, undefined, "OFFER_INVALID");
}

function parseDate(value: unknown, message: string): Date {
  const date = new Date(String(value));
  if (!value || Number.isNaN(date.getTime())) throw new AppError(message, 400, undefined, "OFFER_INVALID");
  return date;
}

function validatedOfferFields(input: SupplierOfferInput) {
  if (!input.foodstuffName?.trim()) throw new AppError("Foodstuff is required", 400, undefined, "OFFER_INVALID");
  if (!input.packSize?.trim()) throw new AppError("Pack size is required", 400, undefined, "OFFER_INVALID");
  assertPositiveInt(input.pricePerShareMinor, "Price per share must be more than 0");
  assertPositiveInt(input.minimumShares, "Minimum shares must be at least 1");
  assertPositiveInt(input.maximumShares, "Maximum shares must be at least 1");
  if (input.maximumShares < input.minimumShares) {
    throw new AppError("Maximum shares can't be lower than the minimum", 400, undefined, "OFFER_INVALID");
  }
  const windowStartsAt = parseDate(input.windowStartsAt, "Offer window start is required");
  const windowEndsAt = parseDate(input.windowEndsAt, "Offer window end is required");
  if (windowEndsAt <= windowStartsAt) throw new AppError("The offer window must end after it starts", 400, undefined, "OFFER_INVALID");
  const fulfilmentMethods = (input.fulfilmentMethods ?? []).filter((m) => FULFILMENT_METHODS.includes(m));
  if (fulfilmentMethods.length === 0) throw new AppError("Choose delivery, collection or both", 400, undefined, "OFFER_INVALID");
  if (fulfilmentMethods.includes("COLLECTION") && (!input.collectionAddressLine1?.trim() || !input.collectionCity?.trim() || !input.collectionPostcode?.trim())) {
    throw new AppError("Add the collection address", 400, undefined, "OFFER_INVALID");
  }
  const deliveryAreas = (input.deliveryAreas ?? []).map((a) => a.trim().toUpperCase()).filter(Boolean);
  if (fulfilmentMethods.includes("DELIVERY") && deliveryAreas.length === 0) {
    throw new AppError("Add the postcode areas you deliver to", 400, undefined, "OFFER_INVALID");
  }
  return {
    foodstuffName: input.foodstuffName.trim(),
    description: input.description?.trim() || null,
    packSize: input.packSize.trim(),
    weightGrams: input.weightGrams ?? null,
    images: input.images ?? [],
    pricePerShareMinor: input.pricePerShareMinor,
    minimumShares: input.minimumShares,
    maximumShares: input.maximumShares,
    windowStartsAt,
    windowEndsAt,
    fulfilmentMethods,
    deliveryAreas,
    deliveryFeeMinor: input.deliveryFeeMinor ?? null,
    collectionAddressLine1: input.collectionAddressLine1?.trim() || null,
    collectionCity: input.collectionCity?.trim() || null,
    collectionPostcode: input.collectionPostcode?.trim() || null,
    leadTimeDays: input.leadTimeDays ?? null,
  };
}

async function requireOwnAccount(userId: string) {
  const account = await prisma.supplierAccount.findUnique({ where: { userId } });
  if (!account) throw new AppError("Set up your supplier details first", 409, undefined, "SUPPLIER_DETAILS_REQUIRED");
  if (account.supplierState === "SUSPENDED" || account.supplierState === "CLOSED") {
    throw new AppError("Your supply access is paused. Contact support to resolve this.", 403, undefined, "SUPPLIER_SUSPENDED");
  }
  return account;
}

async function requireOwnOffer(userId: string, offerId: string) {
  const offer = await prisma.supplierOffer.findUnique({ where: { id: offerId }, include: { supplierAccount: { select: { userId: true, supplierState: true } } } });
  if (!offer || offer.supplierAccount.userId !== userId) throw new AppError("Offer not found", 404);
  return offer;
}

/** How an offer appears to organisers. Never exposes the supplier's account details. */
function offerCard(offer: {
  id: string; foodstuffName: string; description: string | null; packSize: string; weightGrams: number | null; images: string[];
  currency: string; pricePerShareMinor: number; minimumShares: number; maximumShares: number; windowEndsAt: Date; fulfilmentMethods: string[];
  deliveryAreas: string[]; deliveryFeeMinor: number | null; collectionCity: string | null; supplierAccount: { businessName: string | null };
}) {
  return {
    id: offer.id,
    foodstuffName: offer.foodstuffName,
    description: offer.description,
    packSize: offer.packSize,
    weightGrams: offer.weightGrams,
    images: offer.images,
    currency: offer.currency,
    pricePerShareMinor: offer.pricePerShareMinor,
    minimumShares: offer.minimumShares,
    maximumShares: offer.maximumShares,
    windowEndsAt: offer.windowEndsAt,
    fulfilmentMethods: offer.fulfilmentMethods,
    deliveryAreas: offer.deliveryAreas,
    deliveryFeeMinor: offer.deliveryFeeMinor,
    collectionCity: offer.collectionCity,
    supplierName: offer.supplierAccount.businessName ?? "Verified supplier",
    verifiedSupplier: true,
  };
}

export const supplierOffersService = {
  // ─── Supplier ───────────────────────────────────────────────────────────

  async listMine(userId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId }, select: { id: true } });
    if (!account) return [];
    const offers = await prisma.supplierOffer.findMany({
      where: { supplierAccountId: account.id, status: { not: "SUPERSEDED" } },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(offers.map(async (offer) => ({ ...offer, review: await reviewRequestsService.latestForSubject("SupplierOffer", offer.id) })));
  },

  async getMine(userId: string, offerId: string) {
    const offer = await requireOwnOffer(userId, offerId);
    return { ...offer, review: await reviewRequestsService.latestForSubject("SupplierOffer", offer.id) };
  },

  async createDraft(userId: string, input: SupplierOfferInput) {
    const account = await requireOwnAccount(userId);
    return prisma.supplierOffer.create({
      data: { ...validatedOfferFields(input), supplierAccountId: account.id, market: V1_MARKET, currency: currencyFromCountry(V1_MARKET), status: "DRAFT" },
    });
  },

  /**
   * Price and quantities can change only while no live campaign uses the
   * offer, and an approved offer changes through a new version.
   */
  async update(userId: string, offerId: string, input: SupplierOfferInput) {
    const offer = await requireOwnOffer(userId, offerId);
    const fields = validatedOfferFields(input);
    if (offer.status === "SUPERSEDED") throw new AppError("A newer version of this offer exists", 409, undefined, "OFFER_SUPERSEDED");

    if (offer.status !== "APPROVED") {
      // Editing something in review sends it back to the supplier to resubmit.
      if (offer.status === "IN_REVIEW") await reviewRequestsService.withdrawForSubject("SupplierOffer", offer.id);
      return prisma.supplierOffer.update({ where: { id: offerId }, data: { ...fields, status: "DRAFT" } });
    }

    const liveCampaigns = await prisma.communityCampaign.count({
      where: { supplierOfferId: offerId, status: { notIn: ["DRAFT", "CHANGES_REQUIRED", "CANCELLED", "COMPLETED", "FINANCIALLY_CLOSED", "FAILED", "REJECTED"] } },
    });
    if (liveCampaigns > 0) {
      throw new AppError("This offer's price and quantities can't change while a Community Buy is using it.", 409, undefined, "OFFER_IN_USE");
    }
    return prisma.$transaction(async (tx) => {
      await tx.supplierOffer.update({ where: { id: offerId }, data: { status: "SUPERSEDED" } });
      return tx.supplierOffer.create({
        data: {
          ...fields,
          supplierAccountId: offer.supplierAccountId,
          market: offer.market,
          currency: offer.currency,
          version: offer.version + 1,
          previousVersionId: offer.id,
          status: "DRAFT",
        },
      });
    });
  },

  /** Creates the review records before the app is allowed to say "in review". */
  async submit(userId: string, offerId: string) {
    const offer = await requireOwnOffer(userId, offerId);
    if (offer.status === "IN_REVIEW") {
      return { offer, review: await reviewRequestsService.latestForSubject("SupplierOffer", offerId) };
    }
    if (offer.status !== "DRAFT" && offer.status !== "INFO_REQUIRED" && offer.status !== "REJECTED" && offer.status !== "WITHDRAWN") {
      throw new AppError("This offer can't be submitted right now", 409, undefined, "OFFER_NOT_SUBMITTABLE");
    }
    const account = await requireOwnAccount(userId);

    try {
      return await prisma.$transaction(async (tx) => {
        if (account.supplierState !== "APPROVED") {
          await reviewRequestsService.open({ type: "SUPPLIER_ELIGIBILITY", subjectType: "SupplierAccount", subjectId: account.id, market: offer.market, submittedById: userId }, tx);
        }
        const review = await reviewRequestsService.open({ type: "SUPPLIER_OFFER", subjectType: "SupplierOffer", subjectId: offerId, market: offer.market, submittedById: userId }, tx);
        const updated = await tx.supplierOffer.update({ where: { id: offerId }, data: { status: "IN_REVIEW" } });
        return { offer: updated, review };
      });
    } catch (error) {
      // A double tap: the other submit won, so this one reports the same result.
      if (!isUniqueViolation(error)) throw error;
      return {
        offer: await prisma.supplierOffer.findUnique({ where: { id: offerId } }),
        review: await reviewRequestsService.latestForSubject("SupplierOffer", offerId),
      };
    }
  },

  async withdraw(userId: string, offerId: string) {
    const offer = await requireOwnOffer(userId, offerId);
    if (offer.status !== "IN_REVIEW" && offer.status !== "INFO_REQUIRED") {
      throw new AppError("Only an offer in review can be withdrawn", 409, undefined, "OFFER_NOT_WITHDRAWABLE");
    }
    await reviewRequestsService.withdrawForSubject("SupplierOffer", offerId);
    return prisma.supplierOffer.update({ where: { id: offerId }, data: { status: "WITHDRAWN" } });
  },

  /** S9: campaigns using this supplier's offers. */
  async listSupplierOrders(userId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId }, select: { id: true } });
    if (!account) return [];
    return prisma.communityCampaign.findMany({
      where: { supplierAccountId: account.id, supplierOfferId: { not: null } },
      orderBy: { deadline: "asc" },
      select: { extensionRequests: { where: { status: "PENDING" }, select: { id: true, requestedDeadline: true, reason: true, supplierReconfirmed: true } }, id: true, title: true, status: true, deadline: true, confirmedShares: true, minimumShares: true, goalShares: true, maximumShares: true, reconfirmationQuantity: true, supplierOffer: { select: { foodstuffName: true } } },
    });
  },

  // ─── Organiser (shopping side) ──────────────────────────────────────────

  /** O2: only approved offers, from suppliers who can really be paid, in this viewer's world. */
  async listForOrganisers(userId: string) {
    const isTest = await viewerIsTest(userId);
    const now = new Date();
    const offers = await prisma.supplierOffer.findMany({
      where: {
        status: "APPROVED",
        market: V1_MARKET,
        windowEndsAt: { gt: now },
        supplierAccount: { supplierState: "APPROVED", user: { isTest } },
      },
      orderBy: { approvedAt: "desc" },
      include: { supplierAccount: true },
    });
    return offers.filter((offer) => isSupplierPayoutReady(offer.supplierAccount)).map(offerCard);
  },

  async requestFoodstuff(userId: string, foodstuff: string, area?: string) {
    if (!foodstuff?.trim()) throw new AppError("Tell us what you'd like to buy together", 400, undefined, "DEMAND_INVALID");
    return prisma.demandRequest.create({ data: { userId, foodstuff: foodstuff.trim(), area: area?.trim() || null, market: V1_MARKET } });
  },

  /** O2: a draft linked to the offer. O3's limits are enforced here, not only on screen. */
  async createCampaignDraft(userId: string, input: OfferCampaignInput) {
    const offer = await prisma.supplierOffer.findUnique({ where: { id: input.offerId }, include: { supplierAccount: true } });
    if (!offer || offer.status !== "APPROVED") throw new AppError("This offer isn't available", 404, undefined, "OFFER_NOT_AVAILABLE");
    if (offer.windowEndsAt <= new Date()) throw new AppError("This offer has ended", 409, undefined, "OFFER_NOT_AVAILABLE");
    if ((await viewerIsTest(userId)) !== (await viewerIsTest(offer.supplierAccount.userId))) {
      throw new AppError("This offer isn't available", 404, undefined, "OFFER_NOT_AVAILABLE");
    }

    const goalShares = input.goalShares ?? offer.maximumShares;
    assertGoalWithinOffer(goalShares, offer);
    const deadline = input.deadline ? parseDate(input.deadline, "Choose a deadline") : offer.windowEndsAt;
    assertDeadlineWithinOffer(deadline, offer);
    const method = input.fulfilmentMethod ?? offer.fulfilmentMethods[0];
    if (!offer.fulfilmentMethods.includes(method)) {
      throw new AppError("This offer doesn't include that delivery option", 400, undefined, "CAMPAIGN_OUTSIDE_OFFER_LIMITS");
    }

    const campaign = await communityCampaignsService.create(userId, {
      fromApprovedOffer: true,
      title: input.groupName?.trim() || `${offer.foodstuffName} Community Buy`,
      description: offer.description ?? undefined,
      country: offer.market,
      currency: offer.currency,
      fulfilmentOwner: "SUPPLIER",
      supplierAccountId: offer.supplierAccountId,
      minimumShares: offer.minimumShares,
      goalShares,
      maximumShares: offer.maximumShares,
      pricePerShareMinor: offer.pricePerShareMinor,
      images: offer.images,
      unit: offer.packSize,
      quantityPerOrder: 1,
      deliveryPreference: method as "DELIVERY" | "COLLECTION",
      deliveryResponsibility: "SUPPLIER",
      deliveryCoverageAreas: method === "DELIVERY" ? offer.deliveryAreas : undefined,
      deliveryFeeAmountMinor: method === "DELIVERY" ? (offer.deliveryFeeMinor ?? 0) : undefined,
      collectionAddressLine1: method === "COLLECTION" ? (offer.collectionAddressLine1 ?? undefined) : undefined,
      collectionCity: method === "COLLECTION" ? (offer.collectionCity ?? undefined) : undefined,
      collectionPostcode: method === "COLLECTION" ? (offer.collectionPostcode ?? undefined) : undefined,
      deadline: deadline.toISOString(),
    });
    // The approved offer is the supplier's commitment to this price and range.
    return prisma.communityCampaign.update({
      where: { id: campaign.id },
      data: { supplierOfferId: offer.id, supplierCommitted: true, supplierCommittedAt: new Date() },
    });
  },

  async updateCampaignDraft(userId: string, campaignId: string, input: Omit<OfferCampaignInput, "offerId">) {
    const campaign = await communityCampaignsService.requireOwnedByOrganiserForWrite(userId, campaignId);
    if (!campaign.supplierOfferId) throw new AppError("This campaign isn't built on an offer", 409, undefined, "CAMPAIGN_NOT_ON_OFFER");
    if (campaign.status !== "DRAFT" && campaign.status !== "CHANGES_REQUIRED") {
      throw new AppError("Only a draft can be edited", 409, undefined, "CAMPAIGN_NOT_DRAFT");
    }
    const offer = await prisma.supplierOffer.findUnique({ where: { id: campaign.supplierOfferId } });
    if (!offer) throw new AppError("This offer isn't available", 404, undefined, "OFFER_NOT_AVAILABLE");
    if (input.goalShares !== undefined) assertGoalWithinOffer(input.goalShares, offer);
    const deadline = input.deadline ? parseDate(input.deadline, "Choose a deadline") : undefined;
    if (deadline) assertDeadlineWithinOffer(deadline, offer);
    if (input.fulfilmentMethod && !offer.fulfilmentMethods.includes(input.fulfilmentMethod)) {
      throw new AppError("This offer doesn't include that delivery option", 400, undefined, "CAMPAIGN_OUTSIDE_OFFER_LIMITS");
    }
    return prisma.communityCampaign.update({
      where: { id: campaignId },
      data: {
        ...(input.groupName?.trim() ? { title: input.groupName.trim() } : {}),
        ...(input.goalShares !== undefined ? { goalShares: input.goalShares, targetAmount: input.goalShares * offer.pricePerShareMinor } : {}),
        ...(deadline ? { deadline } : {}),
        ...(input.fulfilmentMethod ? fulfilmentFields(input.fulfilmentMethod, offer) : {}),
      },
    });
  },

  /** O4: organiser checks, then the auto-approval policy, else one manual review. */
  async submitCampaign(userId: string, campaignId: string) {
    const campaign = await communityCampaignsService.requireOwnedByOrganiserForWrite(userId, campaignId);
    if (!campaign.supplierOfferId) throw new AppError("This campaign isn't built on an offer", 409, undefined, "CAMPAIGN_NOT_ON_OFFER");

    if (campaign.status === "UNDER_REVIEW" || campaign.status === "LIVE") {
      return { campaign, review: await reviewRequestsService.latestForSubject("CommunityCampaign", campaignId), outcome: campaign.status === "LIVE" ? "LIVE" : "IN_REVIEW" };
    }

    const missing = await organiserChecksMissing(userId);
    if (missing.length > 0) {
      throw new AppError("A little more is needed before this can go live.", 409, { missing }, "ORGANISER_CHECKS_MISSING");
    }

    await communityCampaignsService.submit(userId, campaignId);

    if (await passesAutoApproval(userId, campaignId)) {
      await communityCampaignsService.approve(AUTO_APPROVAL_ACTOR, campaignId);
      const live = await communityCampaignsService.publish(userId, campaignId);
      const review = await reviewRequestsService.recordAutoApproved({
        type: "COMMUNITY_BUY_CAMPAIGN", subjectType: "CommunityCampaign", subjectId: campaignId, market: campaign.country ?? V1_MARKET, submittedById: userId,
      });
      await grantOrganiser(userId, campaign.country ?? V1_MARKET);
      await notifyOfferCampaignLive(campaignId);
      return { campaign: live, review, outcome: "LIVE" };
    }

    const review = await reviewRequestsService.open({
      type: "COMMUNITY_BUY_CAMPAIGN", subjectType: "CommunityCampaign", subjectId: campaignId, market: campaign.country ?? V1_MARKET, submittedById: userId,
    });
    await grantOrganiser(userId, campaign.country ?? V1_MARKET);
    const updated = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    return { campaign: updated, review, outcome: "IN_REVIEW" };
  },

  /** Withdraw is available until the first participant joins. The draft is kept. */
  async withdrawCampaign(userId: string, campaignId: string) {
    const campaign = await communityCampaignsService.requireOwnedByOrganiserForWrite(userId, campaignId);
    if (campaign.termsLockedAt || campaign.confirmedShares > 0) {
      throw new AppError("Someone has already joined, so this can't be withdrawn. End it early instead.", 409, undefined, "CAMPAIGN_HAS_PARTICIPANTS");
    }
    if (!["UNDER_REVIEW", "APPROVED", "LIVE"].includes(campaign.status)) {
      throw new AppError("This campaign can't be withdrawn right now", 409, undefined, "CAMPAIGN_NOT_WITHDRAWABLE");
    }
    await reviewRequestsService.withdrawForSubject("CommunityCampaign", campaignId);
    return prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "DRAFT", publishedAt: null } });
  },

  /** O5b: interest on a "coming soon" link while in review. Never takes payment. */
  async registerInterest(userId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    await prisma.campaignInterest.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      create: { campaignId, userId },
      update: {},
    });
    return { registered: true, count: await prisma.campaignInterest.count({ where: { campaignId } }) };
  },

  /** Phase 1: admins get one daily summary of what organisers asked for, not a message per request. */
  async sendDemandDigest(now = new Date()) {
    const since = new Date(now.getTime() - 86_400_000);
    const groups = await prisma.demandRequest.groupBy({
      by: ["foodstuff"],
      where: { createdAt: { gte: since }, user: { isTest: false } },
      _count: { foodstuff: true },
      orderBy: { _count: { foodstuff: "desc" } },
      take: 20,
    });
    if (groups.length === 0) return { sent: 0, foodstuffs: 0 };
    const admins = await prisma.user.findMany({ where: { role: "ADMIN", isTest: false }, select: { id: true } });
    const list = groups.map((g) => `${g.foodstuff} (${g._count.foodstuff})`).join(", ");
    const day = now.toISOString().slice(0, 10);
    for (const admin of admins) {
      await notifyUserInAppAndEmail({
        userId: admin.id,
        title: "Foodstuff requests today",
        body: `Organisers asked for: ${list}.`,
        event: "demand_digest",
        dedupeKey: `demand_digest:${day}:${admin.id}`,
      });
    }
    return { sent: admins.length, foodstuffs: groups.length };
  },

  async listDemandForAdmin() {
    const groups = await prisma.demandRequest.groupBy({ by: ["foodstuff"], _count: { foodstuff: true }, orderBy: { _count: { foodstuff: "desc" } }, take: 200 });
    return groups.map((g) => ({ foodstuff: g.foodstuff, requests: g._count.foodstuff }));
  },
};

function assertGoalWithinOffer(goalShares: unknown, offer: { minimumShares: number; maximumShares: number }): void {
  if (!Number.isInteger(goalShares) || (goalShares as number) < offer.minimumShares || (goalShares as number) > offer.maximumShares) {
    throw new AppError(`Your goal must be between ${offer.minimumShares} and ${offer.maximumShares} shares.`, 400, undefined, "CAMPAIGN_OUTSIDE_OFFER_LIMITS");
  }
}

function assertDeadlineWithinOffer(deadline: Date, offer: { windowEndsAt: Date }): void {
  if (deadline <= new Date() || deadline > offer.windowEndsAt) {
    throw new AppError("Choose a deadline within this offer's window.", 400, undefined, "CAMPAIGN_OUTSIDE_OFFER_LIMITS");
  }
}

function fulfilmentFields(method: string, offer: {
  deliveryAreas: string[]; deliveryFeeMinor: number | null; collectionAddressLine1: string | null; collectionCity: string | null; collectionPostcode: string | null;
}) {
  return method === "DELIVERY"
    ? { deliveryPreference: "DELIVERY" as const, deliveryCoverageAreas: offer.deliveryAreas, deliveryFeeAmountMinor: offer.deliveryFeeMinor ?? 0, collectionAddressLine1: null, collectionCity: null, collectionPostcode: null }
    : { deliveryPreference: "COLLECTION" as const, deliveryCoverageAreas: [], deliveryFeeAmountMinor: null, collectionAddressLine1: offer.collectionAddressLine1, collectionCity: offer.collectionCity, collectionPostcode: offer.collectionPostcode };
}

/** Only what's missing, so nothing already verified is asked for again. */
export async function organiserChecksMissing(userId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true, phoneVerifiedAt: true } });
  const missing: string[] = [];
  if (!user?.phoneVerifiedAt) missing.push("phone");
  if (!user?.emailVerifiedAt) missing.push("email");
  return missing;
}

/** The auto-approval policy. Any failing condition means a manual review; a badge alone never approves. */
async function passesAutoApproval(userId: string, campaignId: string): Promise<boolean> {
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { supplierOffer: { include: { supplierAccount: true } }, organiser: true } });
  const offer = campaign?.supplierOffer;
  if (!campaign || !offer) return false;

  // 1. At least one successful campaign and an active organiser capability.
  const [successful, grant] = await Promise.all([
    prisma.communityCampaign.count({
      where: { organiserId: campaign.organiserId, id: { not: campaignId }, status: { in: ["SUCCEEDED", "FULFILLING", "COMPLETED", "FINANCIALLY_CLOSED"] } },
    }),
    prisma.capabilityGrant.findUnique({ where: { userId_capability_market: { userId, capability: "ORGANISER", market: campaign.country ?? V1_MARKET } } }),
  ]);
  if (successful < 1 || grant?.status !== "ACTIVE") return false;

  // 2. The offer is approved with no open issue.
  if (offer.status !== "APPROVED") return false;

  // 3. Goal, deadline and delivery are within the offer's limits.
  const goal = campaign.goalShares ?? 0;
  if (goal < offer.minimumShares || goal > offer.maximumShares) return false;
  if (!campaign.deadline || campaign.deadline > offer.windowEndsAt) return false;
  if (!offer.fulfilmentMethods.includes(campaign.deliveryPreference)) return false;

  // 4. The name passes the content check.
  if (BANNED_CAMPAIGN_WORDS.test(`${campaign.title} ${campaign.description ?? ""}`)) return false;

  // 5. No open dispute, chargeback or suspension on the organiser or supplier.
  if (campaign.organiser.isRestricted || offer.supplierAccount.supplierState !== "APPROVED") return false;
  const openCases = await prisma.communityBuySupportCase.count({
    where: {
      status: { notIn: ["RESOLVED", "CLOSED"] },
      campaign: { OR: [{ organiserId: campaign.organiserId }, { supplierAccountId: offer.supplierAccountId }] },
    },
  });
  return openCases === 0;
}

async function grantOrganiser(userId: string, market: string): Promise<void> {
  await prisma.capabilityGrant.upsert({
    where: { userId_capability_market: { userId, capability: "ORGANISER", market } },
    create: { userId, capability: "ORGANISER", market, status: "ACTIVE", grantedAt: new Date() },
    update: {},
  });
}

/** Whether this market requires organisers to build on an approved offer. */
export async function offersRequiredIn(market: string): Promise<boolean> {
  const config = await marketConfigurationService.get(market);
  return (config as { communityBuyOffersRequired?: boolean } | null)?.communityBuyOffersRequired === true;
}
