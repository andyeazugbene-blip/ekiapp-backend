import type { FulfilmentMethod, OfferSubstitutionMode, SubscriptionFrequency } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { marketConfigurationService } from "../community-buy/market-configuration.service";

export interface UpsertSubscriptionOfferInput {
  title: string;
  description?: string;
  productIds: string[];
  frequencies: SubscriptionFrequency[];
  substitutionPolicy?: string;
  substitutionMode?: OfferSubstitutionMode;
  renewalCutoffHours?: number;
  fulfilmentMethod?: FulfilmentMethod;
  preparationHours?: number | null;
  discountPercent?: number | null;
  maxPriceIncreaseApprovalBps?: number | null;
}

function validatePricingAndFulfilment(input: Partial<UpsertSubscriptionOfferInput>) {
  if (input.discountPercent !== undefined && input.discountPercent !== null) {
    if (!Number.isFinite(input.discountPercent) || input.discountPercent < 0 || input.discountPercent > 90) {
      throw new AppError("Discount percentage must be between 0 and 90", 400);
    }
  }
  if (input.maxPriceIncreaseApprovalBps !== undefined && input.maxPriceIncreaseApprovalBps !== null) {
    if (!Number.isFinite(input.maxPriceIncreaseApprovalBps) || input.maxPriceIncreaseApprovalBps < 0 || input.maxPriceIncreaseApprovalBps > 10000) {
      throw new AppError("Maximum price increase must be between 0 and 10000 basis points (100%)", 400);
    }
  }
  if (input.preparationHours !== undefined && input.preparationHours !== null) {
    if (!Number.isFinite(input.preparationHours) || input.preparationHours < 0) {
      throw new AppError("Preparation time must be a positive number of hours", 400);
    }
  }
}

export const subscriptionOffersService = {
  async create(vendorId: string, input: UpsertSubscriptionOfferInput) {
    if (input.productIds.length === 0) throw new AppError("At least one product is required", 400);
    if (input.frequencies.length === 0) throw new AppError("At least one frequency is required", 400);
    validatePricingAndFulfilment(input);

    const products = await prisma.product.findMany({
      where: { id: { in: input.productIds }, vendorId },
      select: { id: true },
    });
    if (products.length !== input.productIds.length) {
      throw new AppError("One or more products do not belong to this vendor", 400);
    }

    return prisma.subscriptionOffer.create({
      data: {
        vendorId,
        title: input.title,
        description: input.description,
        frequencies: input.frequencies,
        substitutionPolicy: input.substitutionPolicy,
        substitutionMode: input.substitutionMode ?? "ASK_BUYER",
        renewalCutoffHours: input.renewalCutoffHours ?? 24,
        fulfilmentMethod: input.fulfilmentMethod ?? "DELIVERY",
        preparationHours: input.preparationHours,
        discountPercent: input.discountPercent,
        maxPriceIncreaseApprovalBps: input.maxPriceIncreaseApprovalBps,
        products: { create: input.productIds.map((productId) => ({ productId })) },
      },
      include: { products: { include: { product: true } } },
    });
  },

  async update(vendorId: string, offerId: string, input: Partial<UpsertSubscriptionOfferInput>) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);
    validatePricingAndFulfilment(input);

    if (input.productIds) {
      const products = await prisma.product.findMany({
        where: { id: { in: input.productIds }, vendorId },
        select: { id: true },
      });
      if (products.length !== input.productIds.length) {
        throw new AppError("One or more products do not belong to this vendor", 400);
      }
      await prisma.subscriptionOfferProduct.deleteMany({ where: { offerId } });
      await prisma.subscriptionOfferProduct.createMany({
        data: input.productIds.map((productId) => ({ offerId, productId })),
      });
    }

    return prisma.subscriptionOffer.update({
      where: { id: offerId },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.frequencies !== undefined && { frequencies: input.frequencies }),
        ...(input.substitutionPolicy !== undefined && { substitutionPolicy: input.substitutionPolicy }),
        ...(input.substitutionMode !== undefined && { substitutionMode: input.substitutionMode }),
        ...(input.renewalCutoffHours !== undefined && { renewalCutoffHours: input.renewalCutoffHours }),
        ...(input.fulfilmentMethod !== undefined && { fulfilmentMethod: input.fulfilmentMethod }),
        ...(input.preparationHours !== undefined && { preparationHours: input.preparationHours }),
        ...(input.discountPercent !== undefined && { discountPercent: input.discountPercent }),
        ...(input.maxPriceIncreaseApprovalBps !== undefined && { maxPriceIncreaseApprovalBps: input.maxPriceIncreaseApprovalBps }),
      },
      include: { products: { include: { product: true } } },
    });
  },

  async publish(vendorId: string, offerId: string) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId }, include: { products: true } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);
    if (offer.products.length === 0) throw new AppError("Add at least one eligible product before publishing", 400);
    return prisma.subscriptionOffer.update({ where: { id: offerId }, data: { isActive: true } });
  },

  async unpublish(vendorId: string, offerId: string) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);
    return prisma.subscriptionOffer.update({ where: { id: offerId }, data: { isActive: false } });
  },

  /** Stops new renewal cycles from being generated for this offer's subscribers, without unpublishing or cancelling anyone. */
  async pauseRenewals(vendorId: string, offerId: string) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);
    return prisma.subscriptionOffer.update({ where: { id: offerId }, data: { renewalsPaused: true, renewalsPausedAt: new Date() } });
  },

  async resumeRenewals(vendorId: string, offerId: string) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);
    return prisma.subscriptionOffer.update({ where: { id: offerId }, data: { renewalsPaused: false, renewalsPausedAt: null } });
  },

  /**
   * spec §31 "Pause Product Renewals" — stops just this one product from
   * being included in any subscriber's future renewals (createRenewalForCycle
   * in renewals.service.ts filters paused products out at render time), and
   * notifies buyers who currently have it in an active subscription. The
   * rest of each affected subscription — its other items, frequency, next
   * renewal date — is untouched.
   */
  async pauseProduct(vendorId: string, offerId: string, productId: string, reason?: string, expectedReturnAt?: Date) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);
    const link = await prisma.subscriptionOfferProduct.findUnique({ where: { offerId_productId: { offerId, productId } } });
    if (!link) throw new AppError("Product is not part of this offer", 404);

    const [product, updated] = await Promise.all([
      prisma.product.findUnique({ where: { id: productId }, select: { title: true } }),
      prisma.subscriptionOfferProduct.update({
        where: { offerId_productId: { offerId, productId } },
        data: { pausedAt: new Date(), pauseReason: reason, pauseExpectedReturnAt: expectedReturnAt },
      }),
    ]);

    const affected = await prisma.subscriptionItem.findMany({
      where: { productId, subscription: { offerId, status: "ACTIVE" } },
      select: { subscription: { select: { buyerId: true } } },
      distinct: ["subscriptionId"],
    });
    for (const { subscription } of affected) {
      await notificationsService.enqueue({
        userId: subscription.buyerId,
        type: "SUBSCRIPTION_UPDATE",
        title: "A product in your Regular Delivery is paused",
        body: `${product?.title ?? "A product"} in ${offer.title} won't be included in your next renewal${reason ? `: ${reason}` : "."}`,
        data: { type: "subscription_update", event: "product_paused", offerId, productId },
      });
    }
    return updated;
  },

  async resumeProduct(vendorId: string, offerId: string, productId: string) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);
    const link = await prisma.subscriptionOfferProduct.findUnique({ where: { offerId_productId: { offerId, productId } } });
    if (!link) throw new AppError("Product is not part of this offer", 404);
    return prisma.subscriptionOfferProduct.update({
      where: { offerId_productId: { offerId, productId } },
      data: { pausedAt: null, pauseReason: null, pauseExpectedReturnAt: null },
    });
  },

  async listForVendor(vendorId: string) {
    return prisma.subscriptionOffer.findMany({
      where: { vendorId },
      include: { products: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async getPublic(offerId: string) {
    const offer = await prisma.subscriptionOffer.findUnique({
      where: { id: offerId },
      include: { products: { include: { product: true } }, vendor: { select: { id: true, storeName: true } } },
    });
    if (!offer || !offer.isActive) throw new AppError("Offer not found", 404);
    return offer;
  },

  /**
   * Real public discovery — a buyer must be able to find a vendor's Regular
   * Delivery offer without a previous purchase, a deep link, or an
   * existing subscription (architecture gap: the only way in before this
   * was a reorder suggestion driven by past-purchase history). Market-aware
   * (spec rule shared with Community Buy): a country with
   * regularDeliveriesEnabled off returns nothing, never an error, so
   * browsing from an unsupported market just shows an empty list.
   */
  async listPublic(filters: { country?: string; vendorId?: string }) {
    if (filters.country) {
      const config = await marketConfigurationService.get(filters.country);
      if (!config?.regularDeliveriesEnabled) return [];
    }

    return prisma.subscriptionOffer.findMany({
      where: {
        isActive: true,
        vendor: {
          isSuspended: false,
          ...(filters.country ? { country: { equals: filters.country, mode: "insensitive" } } : {}),
        },
        ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
        // At least one real, orderable, non-paused product — an offer with
        // nothing currently available to subscribe to isn't discoverable.
        products: { some: { pausedAt: null, product: { isActive: true, stock: { gt: 0 } } } },
      },
      include: {
        // Public-safe vendor fields only — no contact/payout/verification data.
        vendor: { select: { id: true, storeName: true, avatar: true, country: true, city: true } },
        products: {
          where: { pausedAt: null },
          include: { product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true, stock: true, isActive: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  },
};
