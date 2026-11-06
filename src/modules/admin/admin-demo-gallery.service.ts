import type { CampaignStatus, ContributionStatus, FulfilmentStatus, OrderStatus, Prisma, RenewalStatus, SupplierOfferStatus, SupplierPaymentStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { currencyFromCountry, resolveMarketCode } from "../../shared/currency";

const IMAGE = "https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev/seed-egusi.png";
const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE = 2500;
const MINIMUM = 5;
const GOAL = 20;
const MAXIMUM = 50;

/**
 * Fills a demo account with one example of every state, so each screen can be
 * tried without waiting for a real campaign to get there. Records are written
 * directly and never reach Stripe. Background jobs skip test campaigns, so a
 * status stays as seeded. Running it again only adds what's missing.
 */
export interface GalleryAccount {
  userId: string;
  vendorId: string | null;
  supplierAccountId: string;
  country: string;
}

export interface GalleryCompanion {
  userId: string;
  vendorId: string;
}

type CampaignSpec = {
  key: string;
  label: string;
  status: CampaignStatus;
  shares?: number;
  contribution?: ContributionStatus;
  extra?: Partial<Prisma.CommunityCampaignUncheckedCreateInput>;
  fulfilment?: FulfilmentStatus;
  supplierPayment?: SupplierPaymentStatus;
};

const afterDays = (days: number) => new Date(Date.now() + days * DAY_MS);

/** What a participant's contribution looks like once a campaign is in each status. */
const CONTRIBUTION_FOR: Partial<Record<CampaignStatus, ContributionStatus>> = {
  LIVE: "PLEDGED",
  PAUSED: "PLEDGED",
  CLOSING: "PLEDGED",
  RESCUE_WINDOW: "PLEDGED",
  CANCELLATION_UNDER_REVIEW: "PLEDGED",
  SUCCEEDED: "PAID",
  FULFILLING: "PAID",
  COMPLETED: "PAID",
  FINANCIALLY_CLOSED: "PAID",
  FAILED: "CANCELLED",
  REFUNDING: "REFUND_PROCESSING",
  CANCELLED: "REFUNDED",
};

const ORGANISER_CAMPAIGNS: CampaignSpec[] = [
  { key: "draft", label: "Draft", status: "DRAFT" },
  { key: "under-review", label: "Under review", status: "UNDER_REVIEW" },
  { key: "changes", label: "Changes required", status: "CHANGES_REQUIRED", extra: { reviewNotes: "Please add the pack size to the description." } },
  { key: "approved", label: "Approved, not published", status: "APPROVED" },
  { key: "rejected", label: "Rejected", status: "REJECTED", extra: { reviewNotes: "The supplier couldn't be confirmed for this market." } },
  { key: "live-early", label: "Live, below minimum", status: "LIVE", shares: 2 },
  { key: "live-minimum", label: "Live, minimum reached", status: "LIVE", shares: 8 },
  { key: "live-goal", label: "Live, goal reached", status: "LIVE", shares: GOAL },
  { key: "paused", label: "Paused", status: "PAUSED", shares: 3 },
  { key: "closing", label: "Closing", status: "CLOSING", shares: 6 },
  { key: "completion", label: "Completion period", status: "RESCUE_WINDOW", shares: 3, extra: { rescueEndsAt: afterDays(30), fundingOutcome: "BELOW_MINIMUM" } },
  { key: "succeeded-minimum", label: "Succeeded at minimum", status: "SUCCEEDED", shares: 8, extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-1) } },
  { key: "succeeded-goal", label: "Succeeded at goal", status: "SUCCEEDED", shares: GOAL, extra: { fundingOutcome: "GOAL_REACHED", closedAt: afterDays(-1) } },
  { key: "failed", label: "Ended below minimum", status: "FAILED", shares: 2, extra: { fundingOutcome: "BELOW_MINIMUM", closedAt: afterDays(-1) } },
  { key: "refunding", label: "Refunds in progress", status: "REFUNDING", shares: 2, extra: { fundingOutcome: "BELOW_MINIMUM", closedAt: afterDays(-2) } },
  { key: "fulfilling", label: "Fulfilment in progress", status: "FULFILLING", shares: 8, fulfilment: "PACKING", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-3) } },
  { key: "completed", label: "Completed", status: "COMPLETED", shares: 8, fulfilment: "COMPLETED", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-9) } },
  { key: "closed", label: "Financially closed", status: "FINANCIALLY_CLOSED", shares: 8, fulfilment: "COMPLETED", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-20) } },
  { key: "cancelled", label: "Cancelled", status: "CANCELLED", shares: 2, extra: { closedAt: afterDays(-1) } },
  { key: "cancel-review", label: "Cancellation under review", status: "CANCELLATION_UNDER_REVIEW", shares: 3 },
  { key: "disputed", label: "Disputed", status: "FULFILLING", shares: 8, fulfilment: "DISPATCHED", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-4), disputedAt: new Date(), disputeReason: "Demo: several bags arrived damaged." } },
];

const BUYER_CAMPAIGNS: CampaignSpec[] = [
  { key: "buyer-pledged", label: "You pledged, campaign live", status: "LIVE", shares: 3 },
  { key: "buyer-completion", label: "You pledged, completion period", status: "RESCUE_WINDOW", shares: 3, extra: { rescueEndsAt: afterDays(30), fundingOutcome: "BELOW_MINIMUM" } },
  { key: "buyer-paid", label: "Succeeded, you paid", status: "SUCCEEDED", shares: 8, extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-1) } },
  { key: "buyer-charge-failed", label: "Succeeded, your payment failed", status: "SUCCEEDED", shares: 8, contribution: "CHARGE_FAILED", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-1) } },
  { key: "buyer-failed", label: "Ended below minimum", status: "FAILED", shares: 2, extra: { fundingOutcome: "BELOW_MINIMUM", closedAt: afterDays(-1) } },
  { key: "buyer-refunding", label: "Your refund is in progress", status: "REFUNDING", shares: 2, extra: { fundingOutcome: "BELOW_MINIMUM", closedAt: afterDays(-2) } },
  { key: "buyer-refunded", label: "Your refund is complete", status: "CANCELLED", shares: 2, extra: { closedAt: afterDays(-5) } },
  { key: "buyer-preparing", label: "Being prepared for you", status: "FULFILLING", shares: 8, fulfilment: "PACKING", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-3) } },
  { key: "buyer-ready", label: "Ready to collect", status: "FULFILLING", shares: 8, fulfilment: "READY_FOR_DISPATCH_OR_COLLECTION", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-4) } },
  { key: "buyer-completed", label: "Completed", status: "COMPLETED", shares: 8, fulfilment: "COMPLETED", extra: { fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-9) } },
];

const COMMITTED = { supplierCommitted: true, supplierCommittedAt: afterDays(-10) };
const SUPPLIER_CAMPAIGNS: CampaignSpec[] = [
  { key: "supplier-invited", label: "Invitation to answer", status: "UNDER_REVIEW" },
  { key: "supplier-declined", label: "Invitation you declined", status: "CHANGES_REQUIRED", extra: { supplierDeclinedAt: afterDays(-2), supplierDeclineReason: "Demo: stock isn't available for these dates." } },
  { key: "supplier-accepted", label: "Accepted, campaign live", status: "LIVE", shares: 4, extra: COMMITTED },
  { key: "supplier-final-order", label: "Final order to accept", status: "SUCCEEDED", shares: 8, extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-1), reconfirmationRequestedAt: new Date(), reconfirmationDeadline: afterDays(14), reconfirmationQuantity: 8 } },
  { key: "supplier-confirm-stock", label: "Confirm inventory", status: "FULFILLING", shares: 8, fulfilment: "AWAITING_INVENTORY_CONFIRMATION", supplierPayment: "NOT_RELEASED", extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-2) } },
  { key: "supplier-inventory", label: "Set fulfilment plan", status: "FULFILLING", shares: 8, fulfilment: "INVENTORY_CONFIRMED", supplierPayment: "NOT_RELEASED", extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-3) } },
  { key: "supplier-packing", label: "Packing", status: "FULFILLING", shares: 8, fulfilment: "PACKING", supplierPayment: "NOT_RELEASED", extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-4) } },
  { key: "supplier-ready", label: "Ready for collection", status: "FULFILLING", shares: 8, fulfilment: "READY_FOR_DISPATCH_OR_COLLECTION", supplierPayment: "NOT_RELEASED", extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-5) } },
  { key: "supplier-dispatched", label: "Dispatched", status: "FULFILLING", shares: 8, fulfilment: "DISPATCHED", supplierPayment: "NOT_RELEASED", extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-6) } },
  { key: "supplier-paid", label: "Completed and paid", status: "COMPLETED", shares: 8, fulfilment: "COMPLETED", supplierPayment: "PAID", extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-12) } },
  { key: "supplier-hold", label: "Payment on hold", status: "COMPLETED", shares: 8, fulfilment: "COMPLETED", supplierPayment: "ON_HOLD", extra: { ...COMMITTED, fundingOutcome: "MINIMUM_REACHED", closedAt: afterDays(-12), disputedAt: new Date(), disputeReason: "Demo: a participant reported a delivery problem." } },
];

const OFFER_STATES: { status: SupplierOfferStatus; name: string }[] = [
  { status: "DRAFT", name: "Long Grain Rice (draft)" },
  { status: "IN_REVIEW", name: "Palm Oil (in review)" },
  { status: "INFO_REQUIRED", name: "Yam Flour (more information needed)" },
  { status: "APPROVED", name: "Egusi Seeds (approved)" },
  { status: "REJECTED", name: "Dried Pepper (rejected)" },
];

const ORDER_STATES: OrderStatus[] = ["PENDING", "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED", "CANCELLED", "REFUNDED", "DISPUTED"];

async function ensureOrganiser(userId: string, countryCode: string): Promise<string> {
  const existing = await prisma.organiserProfile.findUnique({ where: { userId }, select: { id: true } });
  if (existing) return existing.id;
  return (await prisma.organiserProfile.create({ data: { userId, country: countryCode }, select: { id: true } })).id;
}

async function seedCampaign(spec: CampaignSpec, ctx: {
  organiserId: string;
  participantUserId: string;
  requesterUserId: string;
  ownerUserId: string;
  countryCode: string;
  currency: string;
  supplierAccountId?: string;
}): Promise<boolean> {
  const marker = `demo_gallery:${ctx.ownerUserId}:${spec.key}`;
  if (await prisma.communityCampaign.findFirst({ where: { adminIssueNotes: marker }, select: { id: true } })) return false;

  const shares = spec.shares ?? 0;
  const contribution = spec.contribution ?? CONTRIBUTION_FOR[spec.status];
  const published = !["DRAFT", "UNDER_REVIEW", "CHANGES_REQUIRED", "APPROVED", "REJECTED"].includes(spec.status);
  const paid = contribution === "PAID" ? shares * PRICE : 0;

  const campaign = await prisma.communityCampaign.create({
    data: {
      organiserId: ctx.organiserId,
      title: `Demo Rice: ${spec.label}`,
      description: "Demo campaign. No real goods are sold and no real money moves.",
      country: ctx.countryCode,
      currency: ctx.currency,
      targetAmount: MINIMUM * PRICE,
      status: spec.status,
      pricePerShareMinor: PRICE,
      minimumShares: MINIMUM,
      goalShares: GOAL,
      maximumShares: MAXIMUM,
      unit: "bag",
      quantityPerOrder: 1,
      images: [IMAGE],
      deadline: published && spec.extra?.closedAt ? spec.extra.closedAt : afterDays(30),
      deliveryPreference: "COLLECTION",
      collectionAddressLine1: "1 Demo Street",
      collectionCity: "Demo City",
      collectionPostcode: "DE1 1MO",
      confirmedShares: shares,
      paidTotal: paid,
      publishedAt: published ? afterDays(-14) : null,
      termsLockedAt: shares > 0 ? afterDays(-13) : null,
      adminIssueNotes: marker,
      ...(ctx.supplierAccountId ? { supplierAccountId: ctx.supplierAccountId, fulfilmentOwner: "SUPPLIER" as const, wholesaleAmountMinor: 1800 } : { fulfilmentOwner: "SELF" as const }),
      ...spec.extra,
    },
    select: { id: true },
  });

  if (shares > 0 && contribution) {
    const participant = await prisma.campaignParticipant.create({ data: { campaignId: campaign.id, userId: ctx.participantUserId }, select: { id: true } });
    const row = await prisma.campaignContribution.create({
      data: { campaignId: campaign.id, participantId: participant.id, amount: shares * PRICE, currency: ctx.currency, quantity: shares, status: contribution },
      select: { id: true },
    });
    // REFUND_PENDING is deliberately never seeded: the refund job acts on it.
    if (contribution === "REFUND_PROCESSING" || contribution === "REFUNDED") {
      await prisma.campaignRefund.create({ data: { contributionId: row.id, amount: shares * PRICE, currency: ctx.currency, status: contribution, idempotencyKey: `demo:${row.id}` } });
    }
  }
  if (spec.fulfilment) {
    await prisma.campaignFulfilment.create({ data: { campaignId: campaign.id, status: spec.fulfilment, method: "COLLECTION", estimatedReadyAt: afterDays(7), notes: "Demo fulfilment." } });
  }
  if (spec.supplierPayment) {
    await prisma.campaignSupplierPayment.create({
      data: {
        campaignId: campaign.id, amount: shares * PRICE, currency: ctx.currency, status: spec.supplierPayment,
        wholesaleAmount: shares * 1800,
        holdReason: spec.supplierPayment === "ON_HOLD" ? "Demo: on hold during a dispute." : null,
      },
    });
  }
  if (spec.status === "CANCELLATION_UNDER_REVIEW") {
    await prisma.campaignCancellationRequest.create({
      data: { campaignId: campaign.id, requestedByUserId: ctx.requesterUserId, reason: "Demo: the supplier can no longer deliver.", hadFinancialActivity: true, preCancellationStatus: "LIVE" },
    });
  }
  return true;
}

async function seedOffers(supplierAccountId: string, market: string, currency: string): Promise<number> {
  let created = 0;
  for (const state of OFFER_STATES) {
    if (await prisma.supplierOffer.findFirst({ where: { supplierAccountId, foodstuffName: state.name }, select: { id: true } })) continue;
    await prisma.supplierOffer.create({
      data: {
        supplierAccountId, market, foodstuffName: state.name, description: "Demo supplier offer.", packSize: "10kg bag", weightGrams: 10000,
        images: [IMAGE], currency, pricePerShareMinor: PRICE, minimumShares: MINIMUM, maximumShares: MAXIMUM,
        windowStartsAt: afterDays(-1), windowEndsAt: afterDays(60), fulfilmentMethods: ["COLLECTION"],
        collectionAddressLine1: "1 Demo Street", collectionCity: "Demo City", collectionPostcode: "DE1 1MO", leadTimeDays: 7,
        status: state.status, approvedAt: state.status === "APPROVED" ? new Date() : null,
      },
    });
    created += 1;
  }
  return created;
}

async function seedOrders(buyerId: string, vendorId: string, currency: string): Promise<number> {
  const product = await prisma.product.findFirst({ where: { vendorId }, select: { id: true, title: true, priceInCents: true } });
  if (!product) return 0;
  let created = 0;
  for (const status of ORDER_STATES) {
    const orderNumber = `DEMO-${buyerId.slice(-6)}-${vendorId.slice(-6)}-${status}`;
    if (await prisma.order.findUnique({ where: { orderNumber }, select: { id: true } })) continue;
    const order = await prisma.order.create({
      data: {
        orderNumber, isTest: true, buyerId, vendorId, status, currency,
        subtotalAmount: product.priceInCents, totalAmount: product.priceInCents, deliveryAddress: "1 Demo Street, Demo City",
        deliveredAt: status === "DELIVERED" || status === "COMPLETED" ? afterDays(-1) : null,
        disputedAt: status === "DISPUTED" ? new Date() : null,
        items: { create: [{ productId: product.id, vendorId, quantity: 1, unitAmount: product.priceInCents, totalAmount: product.priceInCents, productTitle: product.title, currency }] },
      },
      select: { id: true },
    });
    if (status === "DISPUTED") {
      await prisma.dispute.create({ data: { orderId: order.id, buyerId, vendorId, reason: "Demo: the order arrived damaged.", type: "DAMAGED", claim: "Demo dispute.", respondByAt: afterDays(3) } });
    }
    created += 1;
  }
  return created;
}

type SubscriptionSpec = { status: "ACTIVE" | "PAUSED" | "PAYMENT_ATTENTION" | "CANCELLED"; renewal?: RenewalStatus; failure?: string };
const SUBSCRIPTION_STATES: SubscriptionSpec[] = [
  { status: "ACTIVE", renewal: "SCHEDULED" },
  { status: "ACTIVE", renewal: "AWAITING_STOCK" },
  { status: "ACTIVE", renewal: "ORDER_CREATED" },
  { status: "PAUSED" },
  { status: "PAYMENT_ATTENTION", renewal: "PAYMENT_FAILED", failure: "Demo: your card was declined." },
  { status: "CANCELLED" },
];

async function seedSubscriptions(buyerId: string, vendorId: string, currency: string): Promise<number> {
  const offer = await prisma.subscriptionOffer.findFirst({ where: { vendorId }, select: { id: true, products: { select: { productId: true }, take: 1 } } });
  const productId = offer?.products[0]?.productId;
  if (!offer || !productId) return 0;
  if (await prisma.buyerSubscription.findFirst({ where: { buyerId, offerId: offer.id }, select: { id: true } })) return 0;

  const address = await prisma.buyerAddress.create({
    data: { buyerId, recipientName: "Demo Buyer", line1: "1 Demo Street", city: "Demo City", postalCode: "DE1 1MO", country: "United Kingdom" },
    select: { id: true },
  });
  let created = 0;
  for (const state of SUBSCRIPTION_STATES) {
    const live = state.status === "ACTIVE" || state.status === "PAYMENT_ATTENTION";
    const sub = await prisma.buyerSubscription.create({
      data: {
        buyerId, offerId: offer.id, status: state.status, frequency: "MONTHLY", deliveryAddressId: address.id,
        nextRenewalAt: live ? afterDays(14) : null, recurringConsentAt: afterDays(-30),
        pausedAt: state.status === "PAUSED" ? afterDays(-2) : null, pausedReason: state.status === "PAUSED" ? "buyer" : null,
        cancelledAt: state.status === "CANCELLED" ? afterDays(-2) : null, cancelReason: state.status === "CANCELLED" ? "Demo: no longer needed." : null,
        items: { create: [{ productId, quantity: 1 }] },
      },
      select: { id: true },
    });
    if (state.renewal) {
      await prisma.renewal.create({
        data: {
          subscriptionId: sub.id, cycleDate: afterDays(14), status: state.renewal, subtotalAmount: PRICE, currency, failureReason: state.failure ?? null,
          awaitingStockSince: state.renewal === "AWAITING_STOCK" ? new Date() : null,
        },
      });
    }
    created += 1;
  }
  return created;
}

export const adminDemoGalleryService = {
  async seed(main: GalleryAccount, companion: GalleryCompanion) {
    const countryCode = resolveMarketCode(main.country) ?? main.country.trim().toUpperCase();
    const currency = currencyFromCountry(main.country).toUpperCase();
    const ownOrganiser = await ensureOrganiser(main.userId, countryCode);
    const companionOrganiser = await ensureOrganiser(companion.userId, countryCode);
    const shared = { countryCode, currency, ownerUserId: main.userId };

    let campaigns = 0;
    for (const spec of ORGANISER_CAMPAIGNS) {
      if (await seedCampaign(spec, { ...shared, organiserId: ownOrganiser, participantUserId: companion.userId, requesterUserId: main.userId })) campaigns += 1;
    }
    for (const spec of BUYER_CAMPAIGNS) {
      if (await seedCampaign(spec, { ...shared, organiserId: companionOrganiser, participantUserId: main.userId, requesterUserId: companion.userId })) campaigns += 1;
    }
    for (const spec of SUPPLIER_CAMPAIGNS) {
      if (await seedCampaign(spec, { ...shared, organiserId: companionOrganiser, participantUserId: companion.userId, requesterUserId: companion.userId, supplierAccountId: main.supplierAccountId })) campaigns += 1;
    }

    const offers = await seedOffers(main.supplierAccountId, countryCode, currency);
    let orders = await seedOrders(main.userId, companion.vendorId, currency);
    let subscriptions = await seedSubscriptions(main.userId, companion.vendorId, currency);
    if (main.vendorId) {
      orders += await seedOrders(companion.userId, main.vendorId, currency);
      subscriptions += await seedSubscriptions(companion.userId, main.vendorId, currency);
    }
    return { campaigns, offers, orders, subscriptions };
  },
};
