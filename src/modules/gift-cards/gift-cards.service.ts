import { Prisma } from "@prisma/client";
import type { GiftCard, GiftCardStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import {
  computeGiftCardExpiry,
  formatGiftCardCode,
  generateGiftCardCode,
  maskGiftCardCode,
  normaliseGiftCardCode,
} from "./gift-card-code";
import type { PaidGiftCardInfo } from "./gift-cards.notify";
import type {
  CreateGiftCardInput,
  GiftCardEffectiveStatus,
  GiftCardView,
  PurchaseGiftCardInput,
  PurchasedGiftCardView,
  RedeemGiftCardInput,
  RedeemGiftCardResult,
  UpdateGiftCardInput,
} from "./gift-cards.types";

type CardWithTemplate = GiftCard & { _count?: { purchases: number } };

const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY ?? "EUR").toUpperCase();

function toGiftCardView(card: CardWithTemplate): GiftCardView {
  return {
    id: card.id,
    title: card.title,
    description: card.description,
    priceAmount: card.priceAmount,
    priceFormatted: `${(card.priceAmount / 100).toFixed(2)}`,
    currency: card.currency,
    imageUrl: card.imageUrl,
    isActive: card.isActive,
    archivedAt: card.archivedAt ? card.archivedAt.toISOString() : null,
    purchasedCount: card._count?.purchases,
    createdAt: card.createdAt.toISOString(),
  };
}

/** ACTIVE + past expiry is reported as EXPIRED without needing a sweep job. */
export function effectiveGiftCardStatus(
  card: { status: GiftCardStatus; expiresAt: Date | null },
  now: Date = new Date(),
): GiftCardEffectiveStatus {
  if ((card.status === "ACTIVE" || card.status === "PAUSED") && card.expiresAt && card.expiresAt <= now) {
    return "EXPIRED";
  }
  return card.status;
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
    remainingBalance: item.remainingBalance,
    status: effectiveGiftCardStatus(item),
    code: item.code ? formatGiftCardCode(item.code) : null,
    paidAt: item.paidAt ? item.paidAt.toISOString() : null,
    expiresAt: item.expiresAt ? item.expiresAt.toISOString() : null,
    isRedeemed: item.isRedeemed,
    redeemedAt: item.redeemedAt ? item.redeemedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
  };
}

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002");
}

export const giftCardsService = {
  // ─── Admin: Create ─────────────────────────────────────────────────────────
  async create(input: CreateGiftCardInput): Promise<GiftCardView> {
    const card = await prisma.giftCard.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        priceAmount: input.priceAmount,
        currency: input.currency ?? DEFAULT_CURRENCY,
        imageUrl: input.imageUrl ?? null,
        isActive: input.isActive ?? true,
      },
    });
    return toGiftCardView(card);
  },

  // ─── Admin: List catalogue ────────────────────────────────────────────────
  async listAll(opts: { includeArchived?: boolean } = {}): Promise<GiftCardView[]> {
    const cards = await prisma.giftCard.findMany({
      where: opts.includeArchived ? {} : { archivedAt: null },
      include: { _count: { select: { purchases: true } } },
      orderBy: { createdAt: "desc" },
    });
    return cards.map(toGiftCardView);
  },

  async getRaw(cardId: string): Promise<GiftCard> {
    const existing = await prisma.giftCard.findUnique({ where: { id: cardId } });
    if (!existing) throw new AppError("Gift card not found", 404);
    return existing;
  },

  // ─── Admin: Update (no hard delete anywhere: see pause / archive) ─────────
  async update(cardId: string, input: UpdateGiftCardInput): Promise<{ before: GiftCardView; after: GiftCardView }> {
    const existing = await this.getRaw(cardId);

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priceAmount !== undefined) data.priceAmount = input.priceAmount;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const updated = await prisma.giftCard.update({ where: { id: cardId }, data });
    return { before: toGiftCardView(existing), after: toGiftCardView(updated) };
  },

  /** Pause / resume = isActive flag; archive = archivedAt (also inactive). */
  async setCatalogueState(
    cardId: string,
    action: "pause" | "resume" | "archive",
  ): Promise<{ before: GiftCardView; after: GiftCardView }> {
    const existing = await this.getRaw(cardId);
    if (action === "resume" && existing.archivedAt) throw new AppError("Archived gift cards cannot be resumed", 409);
    const data =
      action === "pause"
        ? { isActive: false }
        : action === "resume"
          ? { isActive: true }
          : { isActive: false, archivedAt: existing.archivedAt ?? new Date() };
    const updated = await prisma.giftCard.update({ where: { id: cardId }, data });
    return { before: toGiftCardView(existing), after: toGiftCardView(updated) };
  },

  // ─── Buyer: List active gift cards ────────────────────────────────────────
  async listActive(): Promise<GiftCardView[]> {
    const cards = await prisma.giftCard.findMany({
      where: { isActive: true, archivedAt: null },
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
    if (!giftCard.isActive || giftCard.archivedAt) throw new AppError("Gift card is not available", 400);

    // Created as PENDING_PAYMENT: invisible and unredeemable until the
    // verified Stripe webhook confirms payment.
    const purchased = await prisma.purchasedGiftCard.create({
      data: {
        buyerId,
        giftCardId: giftCard.id,
        recipientEmail: input.recipientEmail ?? null,
        recipientName: input.recipientName ?? null,
        message: input.message ?? null,
        amount: giftCard.priceAmount,
        currency: giftCard.currency,
        status: "PENDING_PAYMENT",
      },
    });

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
      // Never hard-delete: keep the row, marked CANCELLED, for the audit trail.
      await prisma.purchasedGiftCard
        .update({
          where: { id: purchased.id },
          data: { status: "CANCELLED", statusReason: "Payment could not be started", statusChangedAt: new Date() },
        })
        .catch(() => {});
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Stripe PaymentIntent failed for gift card purchase", {
        buyerId,
        giftCardId: giftCard.id,
        errorMessage: errorMsg,
      });
      throw new AppError("Payment provider unavailable", 502);
    }

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

  // ─── Buyer: List PAID purchased gift cards (unpaid rows are hidden) ───────
  async listPurchased(buyerId: string): Promise<PurchasedGiftCardView[]> {
    const items = await prisma.purchasedGiftCard.findMany({
      where: { buyerId, paidAt: { not: null }, status: { not: "PENDING_PAYMENT" } },
      include: { giftCard: { select: { title: true, imageUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    return items.map(toPurchasedView);
  },

  // ─── Webhook: payment confirmed ───────────────────────────────────────────
  /**
   * Called INSIDE the webhook transaction after the WebhookEvent dedupe. Also
   * idempotent on its own (paidAt guard) so a replayed/second event for the
   * same PaymentIntent can never regenerate the code or reset the balance.
   */
  async activatePaidGiftCard(
    tx: Prisma.TransactionClient,
    params: { purchasedGiftCardId: string; paymentIntentId: string; amount: number; currency: string; now?: Date },
  ): Promise<{ outcome: "ACTIVATED"; info: PaidGiftCardInfo } | { outcome: "ALREADY_PAID" | "NOT_FOUND" | "MISMATCH" | "CLOSED" }> {
    const now = params.now ?? new Date();
    const card = await tx.purchasedGiftCard.findUnique({
      where: { id: params.purchasedGiftCardId },
      include: { giftCard: { select: { title: true } }, buyer: { select: { name: true, email: true } } },
    });
    if (!card) return { outcome: "NOT_FOUND" };
    if (card.paidAt) return { outcome: "ALREADY_PAID" };
    if (card.stripePaymentIntentId && card.stripePaymentIntentId !== params.paymentIntentId) return { outcome: "MISMATCH" };
    if (card.amount !== params.amount || card.currency.toLowerCase() !== params.currency.toLowerCase()) {
      return { outcome: "MISMATCH" };
    }
    // A purchase an admin already cancelled is never silently revived by a
    // late payment event: it needs a human (refund) decision.
    if (card.status === "CANCELLED" && card.statusChangedById) return { outcome: "CLOSED" };

    let code = generateGiftCardCode();
    for (let i = 0; i < 5; i++) {
      const clash = await tx.purchasedGiftCard.findUnique({ where: { code }, select: { id: true } });
      if (!clash) break;
      code = generateGiftCardCode();
    }
    const expiresAt = computeGiftCardExpiry(now);

    const res = await tx.purchasedGiftCard.updateMany({
      where: { id: card.id, paidAt: null },
      data: {
        paidAt: now,
        status: "ACTIVE",
        remainingBalance: card.amount,
        code,
        expiresAt,
        stripePaymentIntentId: params.paymentIntentId,
        statusReason: null,
        statusChangedAt: now,
      },
    });
    if (res.count !== 1) return { outcome: "ALREADY_PAID" };

    return {
      outcome: "ACTIVATED",
      info: {
        id: card.id,
        buyerId: card.buyerId,
        buyerName: card.buyer?.name ?? null,
        buyerEmail: card.buyer?.email ?? null,
        recipientEmail: card.recipientEmail,
        recipientName: card.recipientName,
        message: card.message,
        amount: card.amount,
        currency: card.currency,
        code,
        expiresAt,
        title: card.giftCard?.title ?? "Gift card",
      },
    };
  },

  /** Webhook: payment failed / canceled before success. Mark, never delete. */
  async cancelUnpaidGiftCard(purchasedGiftCardId: string, reason: string): Promise<number> {
    const res = await prisma.purchasedGiftCard.updateMany({
      where: { id: purchasedGiftCardId, paidAt: null, status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED", statusReason: reason, statusChangedAt: new Date() },
    });
    return res.count;
  },

  // ─── Buyer: redeem code into the wallet ───────────────────────────────────
  async redeem(userId: string, input: RedeemGiftCardInput): Promise<RedeemGiftCardResult> {
    const code = normaliseGiftCardCode(input.code);
    // Same response for malformed and unknown codes: no oracle for guessing.
    if (!code) throw new AppError("Gift card code not recognised", 404, null, "GIFT_CARD_NOT_FOUND");

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await prisma.$transaction(
          async (tx) => {
            const now = new Date();
            const card = await tx.purchasedGiftCard.findUnique({ where: { code } });
            if (!card || card.status === "PENDING_PAYMENT" || !card.paidAt) {
              throw new AppError("Gift card code not recognised", 404, null, "GIFT_CARD_NOT_FOUND");
            }
            if (card.status === "CANCELLED") {
              throw new AppError("This gift card has been cancelled", 409, null, "GIFT_CARD_CANCELLED");
            }
            if (card.status === "PAUSED") {
              throw new AppError("This gift card is temporarily unavailable. Contact support.", 409, null, "GIFT_CARD_PAUSED");
            }
            if (card.status === "REDEEMED" || card.remainingBalance <= 0) {
              throw new AppError("This gift card has already been fully redeemed", 409, null, "GIFT_CARD_ALREADY_REDEEMED");
            }
            if (card.status === "EXPIRED" || (card.expiresAt && card.expiresAt <= now)) {
              return { expired: true as const, id: card.id };
            }

            let amount = card.remainingBalance;
            if (input.amount !== undefined) {
              if (!Number.isInteger(input.amount) || input.amount <= 0) {
                throw new AppError("amount must be a positive integer (minor units)", 400, null, "GIFT_CARD_INVALID_AMOUNT");
              }
              if (input.amount > card.remainingBalance) {
                throw new AppError("Amount exceeds the remaining balance", 400, null, "GIFT_CARD_INSUFFICIENT_BALANCE");
              }
              amount = input.amount;
            }

            // Conditional decrement: the second of two concurrent redeems
            // matches 0 rows (and the Serializable isolation level aborts the
            // loser outright), so one balance can never be spent twice.
            const dec = await tx.purchasedGiftCard.updateMany({
              where: {
                id: card.id,
                status: "ACTIVE",
                remainingBalance: { gte: amount },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
              data: { remainingBalance: { decrement: amount } },
            });
            if (dec.count !== 1) {
              throw new AppError("This gift card can no longer be redeemed", 409, null, "GIFT_CARD_CONFLICT");
            }
            const balanceAfter = card.remainingBalance - amount;
            const fullyRedeemed = balanceAfter === 0;
            if (fullyRedeemed) {
              await tx.purchasedGiftCard.update({
                where: { id: card.id },
                data: { status: "REDEEMED", isRedeemed: true, redeemedAt: now, statusChangedAt: now },
              });
            }

            // Wallet credit: wallets hold one currency. An empty wallet adopts
            // the card's currency; a funded wallet in another currency refuses.
            let wallet = await tx.buyerWallet.findUnique({ where: { buyerId: userId } });
            if (!wallet) {
              wallet = await tx.buyerWallet.create({ data: { buyerId: userId, currency: card.currency.toLowerCase() } });
            } else if (wallet.currency.toLowerCase() !== card.currency.toLowerCase()) {
              if (wallet.balance === 0) {
                wallet = await tx.buyerWallet.update({ where: { id: wallet.id }, data: { currency: card.currency.toLowerCase() } });
              } else {
                throw new AppError(
                  `Your wallet is in ${wallet.currency.toUpperCase()} but this gift card is in ${card.currency.toUpperCase()}.`,
                  409,
                  null,
                  "GIFT_CARD_CURRENCY_MISMATCH",
                );
              }
            }
            const updatedWallet = await tx.buyerWallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: amount } },
            });
            // REFERRAL_BONUS is the existing non-cash credit type (same one the
            // campaign gift-card grant uses); a dedicated enum value would be a
            // schema change for every wallet consumer.
            const walletTx = await tx.buyerWalletTransaction.create({
              data: {
                walletId: wallet.id,
                buyerId: userId,
                type: "REFERRAL_BONUS",
                amount,
                currency: wallet.currency,
                description: `Gift card redeemed (${maskGiftCardCode(code)})`,
              },
            });
            const redemption = await tx.giftCardRedemption.create({
              data: {
                purchasedGiftCardId: card.id,
                redeemerId: userId,
                amountMinor: amount,
                currency: card.currency,
                walletTransactionId: walletTx.id,
                balanceAfter,
              },
            });
            return {
              expired: false as const,
              redemptionId: redemption.id,
              amount,
              currency: card.currency,
              balanceAfter,
              fullyRedeemed,
              walletBalance: updatedWallet.balance,
            };
          },
          { isolationLevel: "Serializable" },
        );

        if (out.expired) {
          await prisma.purchasedGiftCard
            .updateMany({ where: { id: out.id, status: "ACTIVE" }, data: { status: "EXPIRED", statusChangedAt: new Date() } })
            .catch(() => {});
          throw new AppError("This gift card has expired", 410, null, "GIFT_CARD_EXPIRED");
        }

        void notificationsService
          .enqueue({
            userId,
            type: "BALANCE_CREDITED",
            title: "Gift card redeemed",
            body: `${(out.amount / 100).toFixed(2)} ${out.currency.toUpperCase()} was added to your wallet.`,
            data: { event: "gift_card_redeemed", redemptionId: out.redemptionId },
          })
          .catch(() => {});

        return {
          redemptionId: out.redemptionId,
          amountMinor: out.amount,
          currency: out.currency,
          remainingBalance: out.balanceAfter,
          status: out.fullyRedeemed ? "REDEEMED" : "ACTIVE",
          walletBalance: out.walletBalance,
        };
      } catch (error) {
        if (isSerializationFailure(error)) {
          lastError = error;
          continue; // retry: the winner's write is now visible
        }
        throw error;
      }
    }
    logger.warn("Gift card redeem gave up after serialization retries", { userId });
    void lastError;
    throw new AppError("This gift card is being redeemed elsewhere. Please try again.", 409, null, "GIFT_CARD_CONFLICT");
  },

  // ─── Admin: purchased cards ───────────────────────────────────────────────
  async adminListPurchased(query: {
    q?: string;
    status?: string;
    limit: number;
    cursor?: string;
  }) {
    const now = new Date();
    const and: Prisma.PurchasedGiftCardWhereInput[] = [];
    const status = query.status;
    if (!status || status === "ALL") {
      and.push({ status: { not: "PENDING_PAYMENT" } });
    } else if (status === "EXPIRED") {
      and.push({ OR: [{ status: "EXPIRED" }, { status: { in: ["ACTIVE", "PAUSED"] }, expiresAt: { lte: now } }] });
    } else if (status === "ACTIVE") {
      and.push({ status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    } else if (["PENDING_PAYMENT", "PAUSED", "REDEEMED", "CANCELLED"].includes(status)) {
      and.push({ status: status as GiftCardStatus });
    } else {
      throw new AppError("Invalid status filter", 400);
    }
    const q = query.q?.trim();
    if (q) {
      and.push({
        OR: [
          { id: q },
          { recipientEmail: { contains: q, mode: "insensitive" } },
          { recipientName: { contains: q, mode: "insensitive" } },
          { stripePaymentIntentId: { contains: q } },
          { buyer: { email: { contains: q, mode: "insensitive" } } },
          { buyer: { name: { contains: q, mode: "insensitive" } } },
          ...(q.length >= 4 ? [{ code: { endsWith: q.toUpperCase().replace(/[\s-]/g, "") } }] : []),
        ],
      });
    }

    const items = await prisma.purchasedGiftCard.findMany({
      where: { AND: and },
      include: {
        giftCard: { select: { title: true } },
        buyer: { select: { id: true, name: true, email: true } },
        _count: { select: { redemptions: true } },
      },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      nextCursor = items.pop()?.id ?? null;
    }
    return { items: items.map((i) => this.toAdminRow(i)), nextCursor };
  },

  toAdminRow(i: any) {
    return {
      id: i.id,
      title: i.giftCard?.title ?? "Gift card",
      purchaser: i.buyer ? { id: i.buyer.id, name: i.buyer.name, email: i.buyer.email } : null,
      recipientEmail: i.recipientEmail,
      recipientName: i.recipientName,
      originalValue: i.amount,
      remainingBalance: i.remainingBalance,
      currency: i.currency,
      status: effectiveGiftCardStatus(i),
      storedStatus: i.status,
      statusReason: i.statusReason,
      purchasedAt: (i.paidAt ?? i.createdAt).toISOString(),
      paidAt: i.paidAt ? i.paidAt.toISOString() : null,
      expiresAt: i.expiresAt ? i.expiresAt.toISOString() : null,
      paymentReference: i.stripePaymentIntentId,
      maskedCode: maskGiftCardCode(i.code),
      redemptionCount: i._count?.redemptions ?? undefined,
    };
  },

  async adminGetPurchased(id: string) {
    const card = await prisma.purchasedGiftCard.findUnique({
      where: { id },
      include: {
        giftCard: { select: { title: true } },
        buyer: { select: { id: true, name: true, email: true } },
        redemptions: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!card) throw new AppError("Purchased gift card not found", 404);
    const redeemerIds = Array.from(new Set(card.redemptions.map((r) => r.redeemerId)));
    const redeemers = redeemerIds.length
      ? await prisma.user.findMany({ where: { id: { in: redeemerIds } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(redeemers.map((u) => [u.id, u]));
    return {
      ...this.toAdminRow(card),
      message: card.message,
      statusChangedAt: card.statusChangedAt ? card.statusChangedAt.toISOString() : null,
      redemptions: card.redemptions.map((r) => ({
        id: r.id,
        amountMinor: r.amountMinor,
        currency: r.currency,
        balanceAfter: r.balanceAfter,
        orderId: r.orderId,
        createdAt: r.createdAt.toISOString(),
        redeemer: byId.get(r.redeemerId) ?? { id: r.redeemerId, name: null, email: null },
      })),
    };
  },

  /** Cancel / pause / resume with conditional, transition-checked updates. */
  async adminChangePurchasedStatus(
    id: string,
    action: "cancel" | "pause" | "resume",
    reason: string,
    actorId: string,
  ) {
    const card = await prisma.purchasedGiftCard.findUnique({ where: { id } });
    if (!card) throw new AppError("Purchased gift card not found", 404);
    const effective = effectiveGiftCardStatus(card);

    let from: GiftCardStatus[];
    let to: GiftCardStatus;
    if (action === "cancel") {
      from = ["ACTIVE", "PAUSED", "PENDING_PAYMENT"];
      to = "CANCELLED";
    } else if (action === "pause") {
      from = ["ACTIVE"];
      to = "PAUSED";
    } else {
      from = ["PAUSED"];
      to = "ACTIVE";
      if (effective === "EXPIRED") throw new AppError("An expired gift card cannot be resumed", 409, null, "GIFT_CARD_EXPIRED");
    }
    if (!from.includes(card.status)) {
      throw new AppError(`Cannot ${action} a gift card that is ${effective.toLowerCase().replace("_", " ")}`, 409, null, "INVALID_TRANSITION");
    }

    const res = await prisma.purchasedGiftCard.updateMany({
      where: { id, status: card.status },
      data: { status: to, statusReason: reason, statusChangedAt: new Date(), statusChangedById: actorId },
    });
    if (res.count !== 1) throw new AppError("Gift card changed while you were editing. Reload and retry.", 409);
    return {
      before: { status: card.status, remainingBalance: card.remainingBalance },
      after: { status: to, remainingBalance: card.remainingBalance },
      card,
    };
  },
};
