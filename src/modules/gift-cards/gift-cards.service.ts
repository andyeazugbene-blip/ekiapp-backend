import type { GiftCard } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreateGiftCardInput,
  GiftCardView,
  PurchaseGiftCardInput,
  PurchasedGiftCardView,
  UpdateGiftCardInput,
} from "./gift-cards.types";

function toGiftCardView(card: GiftCard): GiftCardView {
  return {
    id: card.id,
    title: card.title,
    description: card.description,
    priceAmount: card.priceAmount,
    priceFormatted: `${(card.priceAmount / 100).toFixed(2)}`,
    currency: card.currency,
    imageUrl: card.imageUrl,
    isActive: card.isActive,
    createdAt: card.createdAt.toISOString(),
  };
}

function toPurchasedView(item: any): PurchasedGiftCardView {
  return {
    id: item.id,
    giftCardId: item.giftCardId,
    title: item.giftCard?.title ?? "Gift Card",
    imageUrl: item.giftCard?.imageUrl ?? null,
    recipientEmail: item.recipientEmail,
    recipientName: item.recipientName,
    message: item.message,
    amount: item.amount,
    currency: item.currency,
    isRedeemed: item.isRedeemed,
    redeemedAt: item.redeemedAt ? item.redeemedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
  };
}

export const giftCardsService = {
  // ─── Admin: Create ─────────────────────────────────────────────────────────
  async create(input: CreateGiftCardInput): Promise<GiftCardView> {
    const card = await prisma.giftCard.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        priceAmount: input.priceAmount,
        currency: input.currency ?? "EUR",
        imageUrl: input.imageUrl ?? null,
        isActive: input.isActive ?? true,
      },
    });
    return toGiftCardView(card);
  },

  // ─── Admin: List all ──────────────────────────────────────────────────────
  async listAll(): Promise<GiftCardView[]> {
    const cards = await prisma.giftCard.findMany({ orderBy: { createdAt: "desc" } });
    return cards.map(toGiftCardView);
  },

  // ─── Admin: Update ────────────────────────────────────────────────────────
  async update(cardId: string, input: UpdateGiftCardInput): Promise<GiftCardView> {
    const existing = await prisma.giftCard.findUnique({ where: { id: cardId } });
    if (!existing) throw new AppError("Gift card not found", 404);

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priceAmount !== undefined) data.priceAmount = input.priceAmount;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const updated = await prisma.giftCard.update({ where: { id: cardId }, data });
    return toGiftCardView(updated);
  },

  // ─── Admin: Delete ────────────────────────────────────────────────────────
  async delete(cardId: string): Promise<void> {
    const existing = await prisma.giftCard.findUnique({ where: { id: cardId } });
    if (!existing) throw new AppError("Gift card not found", 404);
    await prisma.giftCard.delete({ where: { id: cardId } });
  },

  // ─── Buyer: List active gift cards ────────────────────────────────────────
  async listActive(): Promise<GiftCardView[]> {
    const cards = await prisma.giftCard.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });
    return cards.map(toGiftCardView);
  },

  // ─── Buyer: Purchase gift card (creates Stripe PaymentIntent) ────────────
  async purchase(
    buyerId: string,
    input: PurchaseGiftCardInput,
  ): Promise<{ clientSecret: string; paymentIntentId: string; purchasedId: string; amount: number }> {
    const giftCard = await prisma.giftCard.findUnique({
      where: { id: input.giftCardId },
    });

    if (!giftCard) throw new AppError("Gift card not found", 404);
    if (!giftCard.isActive) throw new AppError("Gift card is not available", 400);

    // Create the purchased record
    const purchased = await prisma.purchasedGiftCard.create({
      data: {
        buyerId,
        giftCardId: giftCard.id,
        recipientEmail: input.recipientEmail ?? null,
        recipientName: input.recipientName ?? null,
        message: input.message ?? null,
        amount: giftCard.priceAmount,
        currency: giftCard.currency,
      },
    });

    // Create a Stripe PaymentIntent
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: giftCard.priceAmount,
        currency: giftCard.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: {
          kind: "gift_card_purchase",
          buyerId,
          purchasedGiftCardId: purchased.id,
          giftCardId: giftCard.id,
        },
      });
    } catch (error) {
      // Cleanup the purchased record
      await prisma.purchasedGiftCard.delete({ where: { id: purchased.id } }).catch(() => {});
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Stripe PaymentIntent failed for gift card purchase", {
        buyerId,
        giftCardId: giftCard.id,
        errorMessage: errorMsg,
      });
      throw new AppError("Payment provider unavailable", 502);
    }

    // Update the purchased record with the payment intent ID
    await prisma.purchasedGiftCard.update({
      where: { id: purchased.id },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    if (!paymentIntent.client_secret) {
      throw new AppError("Stripe failure: no client secret", 502);
    }

    logger.info("Gift card purchase initiated", {
      buyerId,
      giftCardId: giftCard.id,
      purchasedId: purchased.id,
      amount: giftCard.priceAmount,
    });

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      purchasedId: purchased.id,
      amount: giftCard.priceAmount,
    };
  },

  // ─── Buyer: List purchased gift cards ─────────────────────────────────────
  async listPurchased(buyerId: string): Promise<PurchasedGiftCardView[]> {
    const items = await prisma.purchasedGiftCard.findMany({
      where: { buyerId },
      include: { giftCard: { select: { title: true, imageUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    return items.map(toPurchasedView);
  },
};
