import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { resolveStripeCurrency } from "../../shared/currency";
import { notificationsService } from "../notifications/notifications.service";
import { marketConfigurationService } from "./market-configuration.service";

/**
 * Mode A (PAY_NOW_REFUND_ON_FAILURE) reference implementation — spec §8.4.
 * Gated entirely behind MarketConfiguration.communityBuyPaymentsEnabled,
 * which defaults to false for every market (see market-configuration.service.ts).
 * Modes B (authorise/capture) and C (pledge/charge) are NOT implemented —
 * building them without a chosen provider/legal arrangement per country
 * would be inventing financial behavior the client hasn't decided on.
 */
export const campaignContributionsService = {
  async join(userId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== "LIVE") throw new AppError("Campaign not found or not live", 404);

    return prisma.campaignParticipant.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: {},
      create: { campaignId, userId },
    });
  },

  async createContributionIntent(userId: string, campaignId: string, amount: number): Promise<{ contributionId: string; clientSecret: string }> {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== "LIVE") throw new AppError("Campaign not found or not live", 404);
    if (new Date() >= campaign.deadline) throw new AppError("This campaign is no longer accepting contributions", 409);

    const paymentsEnabled = await marketConfigurationService.isCommunityBuyPaymentsEnabled(campaign.country);
    if (!paymentsEnabled) {
      throw new AppError(
        "Community Buy contributions are not yet enabled in this market. This requires an admin decision on payment mode and legal review per the country.",
        403,
      );
    }
    if (amount <= 0) throw new AppError("Contribution amount must be positive", 400);

    // resolveStripeCurrency() falls back to EUR for currencies Stripe doesn't
    // support (e.g. GHS) without converting the amount — submitting it as-is
    // would charge the contributor in the wrong currency for the same
    // numeric amount. Reject instead of inventing an FX conversion.
    if (resolveStripeCurrency(campaign.currency) !== campaign.currency.toLowerCase()) {
      throw new AppError(
        `Contributions are not currently available in ${campaign.currency.toUpperCase()}.`,
        400,
        undefined,
        "CURRENCY_NOT_SUPPORTED",
      );
    }

    const participant = await prisma.campaignParticipant.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: {},
      create: { campaignId, userId },
    });

    const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });

    const contribution = await prisma.campaignContribution.create({
      data: { campaignId, participantId: participant.id, amount, currency: campaign.currency, status: "INITIATED" },
    });

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: resolveStripeCurrency(campaign.currency),
      receipt_email: buyer?.email,
      metadata: { kind: "community_buy_contribution", contributionId: contribution.id, campaignId },
    });

    await prisma.campaignContribution.update({
      where: { id: contribution.id },
      data: { status: "PAYMENT_PROCESSING", stripePaymentIntentId: intent.id },
    });

    if (!intent.client_secret) throw new AppError("Failed to start contribution payment", 502);
    return { contributionId: contribution.id, clientSecret: intent.client_secret };
  },

  /**
   * Server-side verification — never trusts the mobile app's redirect.
   * Re-reads the PaymentIntent directly from Stripe before marking a
   * contribution PAID, per spec §11.2/§22.
   */
  async verifyContribution(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      include: { participant: true },
    });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    if (contribution.status === "PAID") return contribution; // Idempotent.
    if (!contribution.stripePaymentIntentId) throw new AppError("No payment was started for this contribution", 409);

    const intent = await stripe.paymentIntents.retrieve(contribution.stripePaymentIntentId);
    if (intent.status !== "succeeded") {
      return contribution; // Still processing or failed — caller can poll again.
    }

    const updated = await prisma.campaignContribution.update({
      where: { id: contributionId },
      data: { status: "PAID" },
    });
    await notificationsService.enqueue({
      userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: "Contribution confirmed",
      body: "Your contribution has been confirmed.",
      data: { type: "community_campaign_update", event: "contribution_confirmed", campaignId: contribution.campaignId },
    });
    return updated;
  },

  async getMyContribution(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      include: { participant: true, refund: true },
    });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    return contribution;
  },

  // ─── Refunds — spec §8.8 ────────────────────────────────────────────────
  // Refund *records* are created eagerly at campaign-failure time
  // (community-campaigns.service.ts); this submits each pending one to
  // Stripe with its own idempotency key, so a retried sweep can never
  // double-refund the same contribution.

  /** Admin visibility — every refund record with enough context to audit outcomes, newest first. */
  async listRefundsForAdmin(limit = 200) {
    return prisma.campaignRefund.findMany({
      include: {
        contribution: {
          include: {
            campaign: { select: { id: true, title: true, country: true, currency: true } },
            participant: { include: { user: { select: { name: true, email: true } } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  async processPendingRefunds(limit = 50): Promise<{ processed: number; failed: number }> {
    const pending = await prisma.campaignRefund.findMany({ where: { status: "REFUND_PENDING" }, take: limit });
    let processed = 0;
    let failed = 0;
    for (const refund of pending) {
      try {
        await prisma.campaignRefund.update({ where: { id: refund.id }, data: { status: "REFUND_PROCESSING" } });
        const contribution = await prisma.campaignContribution.findUniqueOrThrow({
          where: { id: refund.contributionId },
          include: { participant: true },
        });
        if (!contribution.stripePaymentIntentId) throw new Error("Contribution has no payment intent to refund");

        const stripeRefund = await stripe.refunds.create(
          { payment_intent: contribution.stripePaymentIntentId, amount: refund.amount },
          { idempotencyKey: refund.idempotencyKey },
        );

        await prisma.campaignRefund.update({
          where: { id: refund.id },
          data: { status: "REFUNDED", stripeRefundId: stripeRefund.id },
        });
        await prisma.campaignContribution.update({ where: { id: refund.contributionId }, data: { status: "REFUNDED" } });
        await notificationsService.enqueue({
          userId: contribution.participant.userId,
          type: "COMMUNITY_CAMPAIGN_UPDATE",
          title: "Refund completed",
          body: "Your Community Buy refund has been completed.",
          data: { type: "community_campaign_update", event: "refund_completed", campaignId: contribution.campaignId },
        }).catch(() => {});
        processed++;
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Campaign refund failed", { refundId: refund.id, error: message });
        await prisma.campaignRefund.update({
          where: { id: refund.id },
          data: { status: "REFUND_FAILED", failureReason: message },
        }).catch(() => {});
      }
    }
    return { processed, failed };
  },
};
