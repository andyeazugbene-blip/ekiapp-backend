import { Prisma, RewardType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreateRewardInput,
  UpdateRewardInput,
  RewardView,
  UserRewardView,
} from "./rewards.types";

const WELCOME_REWARD_NAME = "Welcome Gift";

function toRewardView(reward: any): RewardView {
  return {
    id: reward.id,
    name: reward.name,
    description: reward.description,
    type: reward.type,
    value: reward.value,
    currency: reward.currency,
    minOrderAmount: reward.minOrderAmount,
    isActive: reward.isActive,
    maxClaims: reward.maxClaims,
    claimedCount: reward.claimedCount,
    expiresAt: reward.expiresAt ? reward.expiresAt.toISOString() : null,
    createdAt: reward.createdAt.toISOString(),
  };
}

function toUserRewardView(ur: any): UserRewardView {
  return {
    id: ur.id,
    rewardId: ur.rewardId,
    rewardName: ur.reward?.name ?? "Reward",
    rewardType: ur.reward?.type ?? "WALLET_BONUS",
    rewardValue: ur.reward?.value ?? 0,
    rewardCurrency: ur.reward?.currency ?? "GBP",
    claimedAt: ur.claimedAt.toISOString(),
    usedAt: ur.usedAt ? ur.usedAt.toISOString() : null,
    expiresAt: ur.expiresAt ? ur.expiresAt.toISOString() : null,
    description: ur.reward?.description ?? null,
  };
}

export const rewardsService = {
  // ─── Admin: Create ─────────────────────────────────────────────────────────
  async create(input: CreateRewardInput): Promise<RewardView> {
    const reward = await prisma.reward.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        value: input.value,
        currency: input.currency ?? "GBP",
        minOrderAmount: input.minOrderAmount ?? null,
        isActive: input.isActive ?? true,
        maxClaims: input.maxClaims ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    return toRewardView(reward);
  },

  // ─── Admin: List all ──────────────────────────────────────────────────────
  async listAll(): Promise<RewardView[]> {
    const rewards = await prisma.reward.findMany({ orderBy: { createdAt: "desc" } });
    return rewards.map(toRewardView);
  },

  // ─── Admin: Update ────────────────────────────────────────────────────────
  async update(rewardId: string, input: UpdateRewardInput): Promise<RewardView> {
    const reward = await prisma.reward.findUnique({ where: { id: rewardId } });
    if (!reward) throw new AppError("Reward not found", 404);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.type !== undefined) data.type = input.type;
    if (input.value !== undefined) data.value = input.value;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.minOrderAmount !== undefined) data.minOrderAmount = input.minOrderAmount;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.maxClaims !== undefined) data.maxClaims = input.maxClaims;
    if (input.expiresAt !== undefined) {
      data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    }

    const updated = await prisma.reward.update({ where: { id: rewardId }, data });
    return toRewardView(updated);
  },

  // ─── Admin: Delete ────────────────────────────────────────────────────────
  async delete(rewardId: string): Promise<void> {
    const reward = await prisma.reward.findUnique({ where: { id: rewardId } });
    if (!reward) throw new AppError("Reward not found", 404);
    await prisma.reward.delete({ where: { id: rewardId } });
  },

  // ─── Public: List active rewards ──────────────────────────────────────────
  async listActive(): Promise<RewardView[]> {
    const now = new Date();
    const rewards = await prisma.reward.findMany({
      where: {
        isActive: true,
        OR: [{ maxClaims: null }, { claimedCount: { lt: 999999 } }],
      },
      orderBy: { createdAt: "desc" },
    });
    return rewards.filter((r) => !r.expiresAt || r.expiresAt > now).map(toRewardView);
  },

  // ─── Public: Claim a reward (via referral code) ──────────────────────────
  async claimReward(userId: string, referralCode: string): Promise<UserRewardView | null> {
    // Validate referral code
    const referrer = await prisma.user.findFirst({
      where: { referralCode: { equals: referralCode, mode: "insensitive" } },
      select: { id: true },
    });
    if (!referrer) throw new AppError("Referral code not found", 404);
    if (referrer.id === userId) throw new AppError("Cannot use your own referral code", 400);

    // Check already claimed
    const existing = await prisma.userReward.findFirst({
      where: { userId, reward: { name: WELCOME_REWARD_NAME } },
    });
    if (existing) throw new AppError("Welcome gift already claimed", 409);

    // Find the welcome reward
    const welcomeReward = await prisma.reward.findFirst({
      where: { name: WELCOME_REWARD_NAME, isActive: true },
    });
    if (!welcomeReward) throw new AppError("No welcome gift available", 404);

    // Check claim limit
    if (welcomeReward.maxClaims && welcomeReward.claimedCount >= welcomeReward.maxClaims) {
      throw new AppError("Gift fully claimed", 409);
    }

    // Claim within transaction
    const userReward = await prisma.$transaction(async (tx) => {
      const updated = await tx.reward.updateMany({
        where: { id: welcomeReward.id, claimedCount: { lt: welcomeReward.maxClaims ?? 999999 } },
        data: { claimedCount: { increment: 1 } },
      });
      if (updated.count === 0) throw new AppError("Gift fully claimed", 409);

      return tx.userReward.create({
        data: {
          userId,
          rewardId: welcomeReward.id,
          expiresAt: welcomeReward.expiresAt,
        },
        include: { reward: true },
      });
    });

    logger.info("Reward claimed", { userId, rewardId: welcomeReward.id, referralCode });
    return toUserRewardView(userReward);
  },

  // ─── Public: Get user's claimed rewards ─────────────────────────────────
  async getUserRewards(userId: string): Promise<UserRewardView[]> {
    const items = await prisma.userReward.findMany({
      where: { userId },
      include: { reward: true },
      orderBy: { claimedAt: "desc" },
    });
    return items.map(toUserRewardView);
  },

  // ─── Public: Auto-claim welcome reward on referral ──────────────────────
  async autoClaimWelcomeReward(userId: string): Promise<void> {
    try {
      const welcomeReward = await prisma.reward.findFirst({
        where: { name: WELCOME_REWARD_NAME, isActive: true },
      });
      if (!welcomeReward) return;

      const alreadyClaimed = await prisma.userReward.findFirst({
        where: { userId, rewardId: welcomeReward.id },
      });
      if (alreadyClaimed) return;

      if (welcomeReward.maxClaims && welcomeReward.claimedCount >= welcomeReward.maxClaims) return;

      await prisma.$transaction(async (tx) => {
        await tx.reward.updateMany({
          where: { id: welcomeReward.id, claimedCount: { lt: welcomeReward.maxClaims ?? 999999 } },
          data: { claimedCount: { increment: 1 } },
        });
        await tx.userReward.create({
          data: {
            userId,
            rewardId: welcomeReward.id,
            expiresAt: welcomeReward.expiresAt,
          },
        });
      });

      logger.info("Welcome reward auto-claimed", { userId, rewardId: welcomeReward.id });
    } catch (error) {
      logger.error("Auto-claim welcome reward failed", {
        userId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },

  // ─── Auto-grant gift card rewards from eligible campaigns ─────────────
  async grantCampaignGiftCards(buyerId: string): Promise<void> {
    try {
      const now = new Date();
      const PAID_STATUSES = ["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED"] as const;

      const campaigns = await prisma.campaign.findMany({
        where: {
          active: true,
          type: "GIFT_CARD",
          OR: [{ startDate: null }, { startDate: { lte: now } }],
        },
      });

      const live = campaigns.filter((c) => !c.endDate || c.endDate >= now);
      if (live.length === 0) return;

      const orderStats = await prisma.order.findMany({
        where: { buyerId, status: { in: [...PAID_STATUSES] } },
        select: { subtotalAmount: true },
      });

      const paidOrderCount = orderStats.length;
      const totalSpendCents = orderStats.reduce((sum, o) => sum + o.subtotalAmount, 0);
      const isNewCustomer = paidOrderCount <= 1;

      const alreadyGranted = await prisma.userReward.findMany({
        where: { userId: buyerId },
        select: { metadata: true },
      });
      const grantedCampaignIds = new Set(
        alreadyGranted
          .map((ur) => (ur.metadata as any)?.campaignId)
          .filter(Boolean),
      );

      for (const campaign of live) {
        if (grantedCampaignIds.has(campaign.id)) continue;

        if (campaign.minimumOrders != null && paidOrderCount < campaign.minimumOrders) continue;
        if (campaign.minimumSpendCents != null && totalSpendCents < campaign.minimumSpendCents) continue;
        if (campaign.newCustomerOnly && !isNewCustomer) continue;

        const linkedGiftCard = await prisma.giftCard.findFirst({
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
        });

        await prisma.$transaction(async (tx) => {
          const reward = await tx.reward.create({
            data: {
              name: campaign.title,
              description: campaign.subtitle ?? `Gift card reward from campaign`,
              type: "WALLET_BONUS",
              value: campaign.discountValue ?? 0,
              currency: "GBP",
              isActive: true,
              maxClaims: 1,
              claimedCount: 1,
            },
          });

          await tx.userReward.create({
            data: {
              userId: buyerId,
              rewardId: reward.id,
              metadata: {
                isGiftCard: true,
                campaignId: campaign.id,
                campaignTitle: campaign.title,
                giftCardId: linkedGiftCard?.id ?? null,
              },
            },
          });

          if (campaign.discountValue && campaign.discountValue > 0) {
            const wallet = await tx.buyerWallet.upsert({
              where: { buyerId },
              create: { buyerId, currency: "GBP", balance: 0 },
              update: {},
            });

            await tx.buyerWallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: campaign.discountValue } },
            });

            await tx.buyerWalletTransaction.create({
              data: {
                walletId: wallet.id,
                buyerId,
                type: "REFERRAL_BONUS",
                amount: campaign.discountValue,
                currency: "GBP",
                description: `Gift card reward: ${campaign.title}`,
              },
            });
          }
        });

        logger.info("Campaign gift card reward granted", { buyerId, campaignId: campaign.id, value: campaign.discountValue });
      }
    } catch (error) {
      logger.error("grantCampaignGiftCards failed", {
        buyerId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
