import type { BuyerWallet, BuyerWalletTransaction } from "@prisma/client";

import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import type { ApplyWalletInput, ListWalletTransactionsQuery, TopUpInput, TopUpResponse } from "./buyer-wallet.types";

async function getOrCreateWallet(buyerId: string): Promise<BuyerWallet> {
  const existing = await prisma.buyerWallet.findUnique({ where: { buyerId } });
  if (existing) return existing;

  return prisma.buyerWallet.create({
    data: { buyerId, currency: env.defaultCurrency },
  });
}

export const buyerWalletService = {
  async getWallet(buyerId: string): Promise<BuyerWallet> {
    return getOrCreateWallet(buyerId);
  },

  async listTransactions(
    buyerId: string,
    query: ListWalletTransactionsQuery,
  ): Promise<{ items: BuyerWalletTransaction[]; nextCursor: string | null }> {
    const wallet = await getOrCreateWallet(buyerId);

    const items = await prisma.buyerWalletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },

  async topUp(buyerId: string, input: TopUpInput): Promise<TopUpResponse> {
    const wallet = await getOrCreateWallet(buyerId);

    // Create a Stripe PaymentIntent for the wallet top-up.
    // Wallet balance is credited ONLY from the Stripe webhook (payment_intent.succeeded).
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: input.amount,
          currency: wallet.currency,
          automatic_payment_methods: { enabled: true },
          metadata: {
            kind: "wallet_topup",
            buyerId,
          },
        },
        { idempotencyKey: `wallet_topup:${buyerId}:${Date.now()}` },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Stripe PaymentIntent creation failed for wallet top-up", {
        buyerId,
        errorMessage: errorMsg,
      });
      throw new AppError("Payment provider unavailable", 502);
    }

    if (!paymentIntent.client_secret) {
      throw new AppError("Stripe failure: no client secret", 502);
    }

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: input.amount,
      currency: wallet.currency,
    };
  },

  async applyToOrder(buyerId: string, input: ApplyWalletInput): Promise<BuyerWalletTransaction> {
    // Verify order belongs to buyer
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      select: { buyerId: true },
    });
    if (!order) {
      throw new AppError("Order not found", 404);
    }
    if (order.buyerId !== buyerId) {
      throw new AppError("Forbidden", 403);
    }

    // Atomic: conditional balance decrement + transaction record in one DB transaction
    return prisma.$transaction(async (tx) => {
      const walletUpdate = await tx.buyerWallet.updateMany({
        where: { buyerId, balance: { gte: input.amount } },
        data: { balance: { decrement: input.amount } },
      });

      if (walletUpdate.count !== 1) {
        throw new AppError("Insufficient wallet balance", 400);
      }

      const wallet = await tx.buyerWallet.findUniqueOrThrow({ where: { buyerId } });

      return tx.buyerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          buyerId,
          type: "ORDER_DEBIT",
          amount: input.amount,
          currency: wallet.currency,
          description: `Applied to order ${input.orderId}`,
          orderId: input.orderId,
        },
      });
    });
  },

};
