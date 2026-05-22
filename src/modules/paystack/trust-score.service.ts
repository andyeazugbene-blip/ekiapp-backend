import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/**
 * Trust score thresholds for buyer restrictions.
 */
const TRUST_CARD_ONLY_THRESHOLD = 20;
const TRUST_MANUAL_REVIEW_THRESHOLD = 10;

export const trustScoreService = {
  /**
   * Check if buyer is allowed to use bank transfer payment method.
   * Buyers below score 20 are restricted to card-only.
   */
  async canUseBankTransfer(buyerId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: buyerId }, select: { trustScore: true } });
    if (!user) return false;
    return user.trustScore >= TRUST_CARD_ONLY_THRESHOLD;
  },

  /**
   * Check if buyer requires manual review on orders.
   */
  async requiresManualReview(buyerId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: buyerId }, select: { trustScore: true } });
    if (!user) return false;
    return user.trustScore < TRUST_MANUAL_REVIEW_THRESHOLD;
  },

  /**
   * Get trust score for a user.
   */
  async getTrustScore(userId: string): Promise<number> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { trustScore: true } });
    return user?.trustScore ?? 50;
  },

  /**
   * Admin: manually adjust a user's trust score.
   */
  async adminAdjustTrustScore(
    userId: string,
    adjustment: number,
    adminId: string,
  ): Promise<{ trustScore: number }> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, trustScore: true } });
    if (!user) throw new AppError("User not found", 404);

    const newScore = Math.max(0, Math.min(100, user.trustScore + adjustment));

    await prisma.user.update({
      where: { id: userId },
      data: { trustScore: newScore },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: "TRUST_SCORE_ADJUSTED",
        entityType: "User",
        entityId: userId,
        metadata: { previousScore: user.trustScore, newScore, adjustment },
      },
    });

    return { trustScore: newScore };
  },
};
