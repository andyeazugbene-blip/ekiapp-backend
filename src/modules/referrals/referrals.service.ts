import crypto from "crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";

const REFERRAL_BONUS_AMOUNT = 500; // 500 cents = €5
const REFERRAL_CURRENCY = "eur";
const MAX_REFERRAL_BONUSES_PER_30_DAYS = 10;

function generateReferralCode(): string {
  return "REF-" + crypto.randomBytes(4).toString("hex").toUpperCase();
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

  async applyReferral(referredUserId: string, referralCode: string): Promise<void> {
    // Find the referrer
    const referrer = await prisma.user.findUnique({
      where: { referralCode },
      select: { id: true },
    });
    if (!referrer) {
      // Silently ignore invalid referral codes during registration
      logger.warn("Invalid referral code used", { referralCode, referredUserId });
      return;
    }

    if (referrer.id === referredUserId) {
      return; // Can't refer yourself
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

    // Verify this is genuinely the first paid order
    const paidOrderCount = await prisma.order.count({
      where: { buyerId: referredUserId, status: { in: ["PAID", "DELIVERED", "COMPLETED"] } },
    });
    if (paidOrderCount < 1) {
      return; // No paid order yet
    }

    // Transactional: atomically claim the referral, credit wallet, and write ledger.
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

      const wallet = await tx.buyerWallet.upsert({
        where: { buyerId: ref.referrerId },
        update: {},
        create: { buyerId: ref.referrerId, currency: ref.currency },
      });

      await tx.buyerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          buyerId: ref.referrerId,
          type: "REFERRAL_BONUS",
          amount: ref.bonusAmount,
          currency: ref.currency,
          description: "Referral bonus for inviting a friend",
        },
      });

      await tx.buyerWallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: ref.bonusAmount } },
      });

      logger.info("Referral bonus credited", {
        referrerId: ref.referrerId,
        referredId: referredUserId,
        amount: ref.bonusAmount,
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
