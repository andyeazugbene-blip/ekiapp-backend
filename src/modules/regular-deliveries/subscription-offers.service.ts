import type { SubscriptionFrequency } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export interface UpsertSubscriptionOfferInput {
  title: string;
  description?: string;
  productIds: string[];
  frequencies: SubscriptionFrequency[];
  substitutionPolicy?: string;
  renewalCutoffHours?: number;
}

export const subscriptionOffersService = {
  async create(vendorId: string, input: UpsertSubscriptionOfferInput) {
    if (input.productIds.length === 0) throw new AppError("At least one product is required", 400);
    if (input.frequencies.length === 0) throw new AppError("At least one frequency is required", 400);

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
        renewalCutoffHours: input.renewalCutoffHours ?? 24,
        products: { create: input.productIds.map((productId) => ({ productId })) },
      },
      include: { products: { include: { product: true } } },
    });
  },

  async update(vendorId: string, offerId: string, input: Partial<UpsertSubscriptionOfferInput>) {
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) throw new AppError("Offer not found", 404);

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
        ...(input.renewalCutoffHours !== undefined && { renewalCutoffHours: input.renewalCutoffHours }),
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
};
