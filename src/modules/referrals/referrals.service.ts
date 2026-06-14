import crypto from "crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";

const REFERRAL_BONUS_AMOUNT = 500; // 500 cents = €5
const REFERRAL_CURRENCY = "eur";
const MAX_REFERRAL_BONUSES_PER_30_DAYS = 10;

/**
 * Normalize an email for anti-abuse comparison.
 * Strips Gmail dots and +tags, lowercases.
 * "test.user+tag@gmail.com" → "testuser@gmail.com"
 */
function normalizeEmailForAbuse(email: string): string {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return email.toLowerCase();
  // Gmail and googlemail: strip dots and +tags
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const stripped = local.split("+")[0].replace(/\./g, "");
    return `${stripped}@gmail.com`;
  }
  // Other providers: just strip +tags
  const stripped = local.split("+")[0];
  return `${stripped}@${domain}`;
}

function generateReferralCode(): string {
  return "REF-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase();
}

export const referralsService = {
  async getOrCreateReferralCode(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (!user) {
      throw new AppError("User not found", 404);
    }

    if (user.referralCode) {
      return user.referralCode;
    }

    // Generate unique code
    let code = generateReferralCode();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await prisma.user.findUnique({ where: { referralCode: code } });
      if (!existing) break;
      code = generateReferralCode();
      attempts++;
    }

    await prisma.user.update({
      where: { id: userId },
      data: { referralCode: code },
    });

    return code;
  },

  async validateReferralCode(referralCode: string): Promise<{ referrerId: string }> {
    const normalized = normalizeReferralCode(referralCode);
    const referrer = await prisma.user.findFirst({
      where: { referralCode: { equals: normalized, mode: "insensitive" } },
      select: { id: true },
    });
    if (!referrer) {
      throw new AppError("Referral code not found", 404);
    }
    return { referrerId: referrer.id };
  },

  async applyReferral(referredUserId: string, referralCode: string): Promise<void> {
    const normalized = normalizeReferralCode(referralCode);

    // Find the referrer
    const referrer = await prisma.user.findFirst({
      where: { referralCode: { equals: normalized, mode: "insensitive" } },
      select: { id: true },
    });
    if (!referrer) {
      logger.warn("Invalid referral code used", { referralCode: normalized, referredUserId });
      throw new AppError("Referral code not found", 404);
    }

    if (referrer.id === referredUserId) {
      throw new AppError("You cannot use your own referral code", 400);
    }

    // Check if already referred
    const existing = await prisma.referral.findUnique({
      where: { referredId: referredUserId },
    });
    if (existing) {
      return; // Already referred
    }

    // Create referral record
    await prisma.referral.create({
      data: {
        referrerId: referrer.id,
        referredId: referredUserId,
        bonusAmount: REFERRAL_BONUS_AMOUNT,
        currency: REFERRAL_CURRENCY,
      },
    });

    // Update the referred user
    await prisma.user.update({
      where: { id: referredUserId },
      data: { referredBy: referrer.id },
    });
  },

  /**
   * Credit referral bonus only after referred user's first paid order.
   * Called from payment_intent.succeeded webhook handler.
   * Idempotent: creditedAt acts as one-time marker.
   */
  async creditReferralBonusOnFirstOrder(referredUserId: string): Promise<void> {
    const referral = await prisma.referral.findUnique({
      where: { referredId: referredUserId },
    });
    if (!referral || referral.creditedAt) {
      return; // No referral or already credited
    }

    // Self-referral guard (should be caught at apply time, but double-check)
    if (referral.referrerId === referredUserId) {
      logger.warn("Self-referral detected, skipping bonus", { referredUserId });
      return;
    }

    // Gmail normalization anti-abuse: check if referrer and referred share the same normalized email
    const [referrerUser, referredUser] = await Promise.all([
      prisma.user.findUnique({ where: { id: referral.referrerId }, select: { email: true } }),
      prisma.user.findUnique({ where: { id: referredUserId }, select: { email: true } }),
    ]);
    if (referrerUser && referredUser) {
      if (normalizeEmailForAbuse(referrerUser.email) === normalizeEmailForAbuse(referredUser.email)) {
        logger.warn("Referral abuse: same normalized email", {
          referrerId: referral.referrerId,
          referredId: referredUserId,
        });
        return;
      }
    }

    // Verify this is genuinely the first paid order
    const paidOrderCount = await prisma.order.count({
      where: { buyerId: referredUserId, status: { in: ["PAID", "DELIVERED", "COMPLETED"] } },
    });
    if (paidOrderCount < 1) {
      return; // No paid order yet
    }

    // Look up active rewards from the admin Gifts & Rewards panel.
    // These determine the amounts for referrer and referee.
    const referralReward = await prisma.reward.findFirst({
      where: { name: "Referral Bonus", isActive: true },
    });
    const welcomeReward = await prisma.reward.findFirst({
      where: { name: "Welcome Gift", isActive: true },
    });
    const referrerAmount = referralReward?.value ?? referral.bonusAmount;
    const referrerCurrency = referralReward?.currency ?? referral.currency;
    const refereeAmount = welcomeReward?.value ?? 500;
    const refereeCurrency = welcomeReward?.currency ?? referral.currency;

    // Transactional: atomically credit both wallets and mark rewards claimed.
    await prisma.$transaction(async (tx) => {
      const ref = await tx.referral.findUnique({ where: { referredId: referredUserId } });
      if (!ref || ref.creditedAt || ref.referrerId === referredUserId) return;

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentCredits = await tx.referral.count({
        where: {
          referrerId: ref.referrerId,
          creditedAt: { gte: thirtyDaysAgo },
        },
      });
      if (recentCredits >= MAX_REFERRAL_BONUSES_PER_30_DAYS) {
        logger.warn("Referral bonus skipped: 30-day cap reached", {
          referrerId: ref.referrerId,
          referredId: referredUserId,
          cap: MAX_REFERRAL_BONUSES_PER_30_DAYS,
        });
        return;
      }

      const claim = await tx.referral.updateMany({
        where: { id: ref.id, creditedAt: null },
        data: { creditedAt: new Date() },
      });
      if (claim.count !== 1) return;

      // ─── 1. Credit referrer wallet ─────────────────────────────────
      const referrerWallet = await tx.buyerWallet.upsert({
        where: { buyerId: ref.referrerId },
        update: {},
        create: { buyerId: ref.referrerId, currency: referrerCurrency },
      });

      await tx.buyerWalletTransaction.create({
        data: {
          walletId: referrerWallet.id,
          buyerId: ref.referrerId,
          type: "REFERRAL_BONUS",
          amount: referrerAmount,
          currency: referrerCurrency,
          description: "Referral bonus for inviting a friend",
        },
      });

      await tx.buyerWallet.update({
        where: { id: referrerWallet.id },
        data: { balance: { increment: referrerAmount } },
      });

      // Mark referral reward as claimed for referrer (no unique constraint, use findFirst)
      if (referralReward) {
        const alreadyClaimed = await tx.userReward.findFirst({
          where: { userId: ref.referrerId, rewardId: referralReward.id },
        });
        if (!alreadyClaimed) {
          await tx.userReward.create({
            data: { userId: ref.referrerId, rewardId: referralReward.id },
          });
          await tx.reward.updateMany({
            where: { id: referralReward.id, claimedCount: { lt: referralReward.maxClaims ?? 999999 } },
            data: { claimedCount: { increment: 1 } },
          });
        }
      }

      // ─── 2. Credit referred friend wallet ──────────────────────────
      if (refereeAmount > 0) {
        const refereeWallet = await tx.buyerWallet.upsert({
          where: { buyerId: referredUserId },
          update: {},
          create: { buyerId: referredUserId, currency: refereeCurrency },
        });

        await tx.buyerWalletTransaction.create({
          data: {
            walletId: refereeWallet.id,
            buyerId: referredUserId,
            type: "REFERRAL_BONUS",
            amount: refereeAmount,
            currency: refereeCurrency,
            description: "Welcome gift for joining via referral",
          },
        });

        await tx.buyerWallet.update({
          where: { id: refereeWallet.id },
          data: { balance: { increment: refereeAmount } },
        });

        if (welcomeReward) {
          const alreadyClaimed = await tx.userReward.findFirst({
            where: { userId: referredUserId, rewardId: welcomeReward.id },
          });
          if (!alreadyClaimed) {
            await tx.userReward.create({
              data: { userId: referredUserId, rewardId: welcomeReward.id },
            });
            await tx.reward.updateMany({
              where: { id: welcomeReward.id, claimedCount: { lt: welcomeReward.maxClaims ?? 999999 } },
              data: { claimedCount: { increment: 1 } },
            });
          }
        }
      }

      logger.info("Referral bonuses credited", {
        referrerId: ref.referrerId,
        referredId: referredUserId,
        referrerAmount,
        refereeAmount,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  },

  async getReferralStats(userId: string): Promise<{
    referralCode: string;
    totalReferred: number;
    totalEarned: number;
    currency: string;
  }> {
    const code = await this.getOrCreateReferralCode(userId);

    const referrals = await prisma.referral.findMany({
      where: { referrerId: userId },
      select: { bonusAmount: true, creditedAt: true },
    });

    const totalReferred = referrals.length;
    const totalEarned = referrals
      .filter((r) => r.creditedAt !== null)
      .reduce((sum, r) => sum + r.bonusAmount, 0);

    return {
      referralCode: code,
      totalReferred,
      totalEarned,
      currency: REFERRAL_CURRENCY,
    };
  },
};
