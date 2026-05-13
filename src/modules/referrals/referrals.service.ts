import crypto from "crypto";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { buyerWalletService } from "../buyer-wallet/buyer-wallet.service";

const REFERRAL_BONUS_AMOUNT = 500; // 500 cents = £5 / $5
const REFERRAL_CURRENCY = "usd";

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

  async creditReferralBonus(referredUserId: string): Promise<void> {
    const referral = await prisma.referral.findUnique({
      where: { referredId: referredUserId },
    });
    if (!referral || referral.creditedAt) {
      return; // No referral or already credited
    }

    // Credit the referrer
    await buyerWalletService.creditReferralBonus(
      referral.referrerId,
      referral.bonusAmount,
      `Referral bonus for inviting a friend`,
    );

    // Mark as credited
    await prisma.referral.update({
      where: { id: referral.id },
      data: { creditedAt: new Date() },
    });
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
