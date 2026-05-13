import type { BuyerWallet, BuyerWalletTransaction } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { ApplyWalletInput, ListWalletTransactionsQuery, TopUpInput } from "./buyer-wallet.types";

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
      orderBy: { createdAt: "desc" },
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

  async topUp(buyerId: string, input: TopUpInput): Promise<BuyerWalletTransaction> {
    const wallet = await getOrCreateWallet(buyerId);

    // In production, this would create a Stripe PaymentIntent for the top-up
    // and only credit the wallet on webhook success. For now, we credit directly.
    const [tx] = await prisma.$transaction([
      prisma.buyerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          buyerId,
          type: "TOP_UP",
          amount: input.amount,
          currency: wallet.currency,
          description: `Wallet top-up of ${input.amount}`,
        },
      }),
      prisma.buyerWallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: input.amount } },
      }),
    ]);

    return tx;
  },

  async applyToOrder(buyerId: string, input: ApplyWalletInput): Promise<BuyerWalletTransaction> {
    const wallet = await getOrCreateWallet(buyerId);

    if (wallet.balance < input.amount) {
      throw new AppError("Insufficient wallet balance", 400);
    }

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

    const [tx] = await prisma.$transaction([
      prisma.buyerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          buyerId,
          type: "ORDER_DEBIT",
          amount: input.amount,
          currency: wallet.currency,
          description: `Applied to order ${input.orderId}`,
          orderId: input.orderId,
        },
      }),
      prisma.buyerWallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: input.amount } },
      }),
    ]);

    return tx;
  },

  async creditReferralBonus(buyerId: string, amount: number, description: string): Promise<void> {
    const wallet = await getOrCreateWallet(buyerId);

    await prisma.$transaction([
      prisma.buyerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          buyerId,
          type: "REFERRAL_BONUS",
          amount,
          currency: wallet.currency,
          description,
        },
      }),
      prisma.buyerWallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      }),
    ]);
  },
};
