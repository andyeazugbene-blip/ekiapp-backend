import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { resolveStripeCurrency } from "../../shared/currency";
import { notificationsService } from "../notifications/notifications.service";
import { marketConfigurationService } from "./market-configuration.service";

/**
 * Pay-now / refund-on-failure contribution flow — Eki Diaspora App doc §9.
 * Gated entirely behind MarketConfiguration.communityBuyPaymentsEnabled,
 * which defaults to false for every market (see market-configuration.service.ts).
 */

interface ContributionIntentResult {
  contributionId: string;
  clientSecret: string;
  quantity: number;
  amount: number;
  currency: string;
}

async function assertCapacityAvailable(campaign: { maximumShares: number | null; confirmedShares: number }, quantity: number): Promise<void> {
  const maximum = campaign.maximumShares ?? 0;
  if (campaign.confirmedShares + quantity > maximum) {
    throw new AppError(
      `Only ${Math.max(0, maximum - campaign.confirmedShares)} share(s) remain available.`,
      409,
      undefined,
      "CAPACITY_UNAVAILABLE",
    );
  }
}

function assertContributableCampaign(campaign: { pricePerShareMinor: number | null; currency: string; maximumShares: number | null; confirmedShares: number }, quantity: number): asserts campaign is { pricePerShareMinor: number; currency: string; maximumShares: number | null; confirmedShares: number } {
  if (!campaign.pricePerShareMinor) throw new AppError("This campaign has no price configured", 409);

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
}

async function startContributionIntent(
  campaignId: string,
  campaign: { pricePerShareMinor: number; currency: string },
  participantId: string,
  quantity: number,
  isOrganiserTopUp: boolean,
  receiptEmail: string | undefined,
): Promise<ContributionIntentResult> {
  const amount = quantity * campaign.pricePerShareMinor;

  const contribution = await prisma.campaignContribution.create({
    data: { campaignId, participantId, amount, currency: campaign.currency, quantity, isOrganiserTopUp, status: "INITIATED" },
  });

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: resolveStripeCurrency(campaign.currency),
    receipt_email: receiptEmail,
    metadata: { kind: "community_buy_contribution", contributionId: contribution.id, campaignId, quantity: String(quantity), isOrganiserTopUp: String(isOrganiserTopUp) },
  });

  await prisma.campaignContribution.update({
    where: { id: contribution.id },
    data: { status: "PAYMENT_PROCESSING", stripePaymentIntentId: intent.id },
  });

  if (!intent.client_secret) throw new AppError("Failed to start contribution payment", 502);
  return { contributionId: contribution.id, clientSecret: intent.client_secret, quantity, amount, currency: campaign.currency };
}

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

  async createContributionIntent(userId: string, campaignId: string, quantity: number): Promise<ContributionIntentResult> {
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

    assertContributableCampaign(campaign, quantity);
    await assertCapacityAvailable(campaign, quantity);

    const participant = await prisma.campaignParticipant.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: {},
      create: { campaignId, userId },
    });

    const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return startContributionIntent(campaignId, campaign, participant.id, quantity, false, buyer?.email);
  },

  /** Doc Screen 106 — organiser purchases the shortfall through the same checkout, only while the campaign is in RESCUE_WINDOW. */
  async createOrganiserTopUp(userId: string, campaignId: string, quantity: number): Promise<ContributionIntentResult> {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !organiser || campaign.organiserId !== organiser.id) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "RESCUE_WINDOW") {
      throw new AppError("A top-up can only be purchased while the campaign is in its rescue window", 409);
    }

    const paymentsEnabled = await marketConfigurationService.isCommunityBuyPaymentsEnabled(campaign.country);
    if (!paymentsEnabled) {
      throw new AppError("Community Buy contributions are not yet enabled in this market.", 403);
    }

    assertContributableCampaign(campaign, quantity);
    await assertCapacityAvailable(campaign, quantity);

    const participant = await prisma.campaignParticipant.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: {},
      create: { campaignId, userId },
    });

    const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return startContributionIntent(campaignId, campaign, participant.id, quantity, true, buyer?.email);
  },

  /**
   * Server-side verification — never trusts the mobile app's redirect.
   * Re-reads the PaymentIntent directly from Stripe before marking a
   * contribution PAID. Capacity is claimed atomically at this point, not
   * at intent-creation time — a guarded UPDATE that never lets
   * confirmedShares exceed maximumShares even under concurrent final-slot
   * confirmations. If capacity was lost between intent creation and this
   * confirmation, the (already-captured) payment is immediately queued
   * for refund instead of being silently over-counted.
   */
  async verifyContribution(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      include: { participant: true },
    });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    if (contribution.status === "PAID" || contribution.status === "REFUND_PENDING" || contribution.status === "REFUNDED") {
      return contribution; // Idempotent — already resolved one way or the other.
    }
    if (!contribution.stripePaymentIntentId) throw new AppError("No payment was started for this contribution", 409);

    const intent = await stripe.paymentIntents.retrieve(contribution.stripePaymentIntentId);
    if (intent.status !== "succeeded") {
      return contribution; // Still processing or failed — caller can poll again.
    }

    const claimed = await prisma.$transaction(async (tx) => {
      const campaign = await tx.communityCampaign.findUniqueOrThrow({ where: { id: contribution.campaignId } });
      const maximum = campaign.maximumShares ?? 0;
      const maxConfirmedBefore = maximum - contribution.quantity;

      const claim = await tx.communityCampaign.updateMany({
        where: { id: campaign.id, confirmedShares: { lte: maxConfirmedBefore } },
        data: { confirmedShares: { increment: contribution.quantity } },
      });

      if (claim.count !== 1) return false;

      await tx.campaignContribution.update({ where: { id: contributionId }, data: { status: "PAID" } });

      // First confirmed contribution locks the campaign's financial terms —
      // doc Screen 102 / spec §8.10.
      if (!campaign.termsLockedAt) {
        await tx.communityCampaign.update({ where: { id: campaign.id }, data: { termsLockedAt: new Date() } });
      }
      return true;
    });

    if (!claimed) {
      // Capacity was gone by the time this payment confirmed (concurrent
      // final-slot race). The charge already succeeded — do not keep the
      // money for a share that was never actually available. Refund it
      // through the exact same idempotent refund path as a failed campaign.
      logger.warn("Community Buy contribution paid after capacity was already full — queuing refund", {
        contributionId,
        campaignId: contribution.campaignId,
      });
      await prisma.$transaction(async (tx) => {
        await tx.campaignContribution.update({ where: { id: contributionId }, data: { status: "REFUND_PENDING" } });
        await tx.campaignRefund.create({
          data: {
            contributionId,
            amount: contribution.amount,
            currency: contribution.currency,
            status: "REFUND_PENDING",
            idempotencyKey: `refund:${contributionId}`,
          },
        }).catch((error: any) => {
          if (error?.code !== "P2002") throw error;
        });
      });
      await notificationsService.enqueue({
        userId,
        type: "COMMUNITY_CAMPAIGN_UPDATE",
        title: "This campaign filled up",
        body: "All shares were taken just before your payment completed. You have not been charged — a refund is on its way.",
        data: { type: "community_campaign_update", event: "capacity_refund", campaignId: contribution.campaignId },
      });
      return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contributionId } });
    }

    await notificationsService.enqueue({
      userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: "Contribution confirmed",
      body: "Your contribution has been confirmed.",
      data: { type: "community_campaign_update", event: "contribution_confirmed", campaignId: contribution.campaignId },
    });
    return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contributionId } });
  },

  async getMyContribution(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      include: { participant: true, refund: true },
    });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    return contribution;
  },

  // ─── Refunds — doc §10 ──────────────────────────────────────────────────
  // Refund *records* are created eagerly at campaign-failure time
  // (community-campaigns.service.ts) or on a capacity-lost race
  // (verifyContribution above); this submits each pending one to Stripe
  // with its own idempotency key, so a retried sweep can never
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

  // ─── Supplier payment — doc §Screen 131, §11 ───────────────────────────

  async releaseSupplierPayment(adminId: string, campaignId: string) {
    const payment = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId }, include: { campaign: { include: { supplier: { include: { vendor: true } } } } } });
    if (!payment) throw new AppError("No supplier payment record exists for this campaign", 404);
    if (payment.status === "PAID") return payment;
    if (payment.status !== "NOT_RELEASED" && payment.status !== "ON_HOLD") {
      throw new AppError("This payment cannot be released from its current state", 409);
    }
    // Doc Screen 131: never release if the payout account changed after
    // campaign approval without reverification.
    const currentStripeAccountId = payment.campaign.supplier.vendor.stripeAccountId;
    if (payment.payoutStripeAccountIdAtApproval && currentStripeAccountId !== payment.payoutStripeAccountIdAtApproval) {
      throw new AppError("The supplier's payout account has changed since approval — reverification is required before release", 409, undefined, "PAYOUT_ACCOUNT_CHANGED");
    }
    return prisma.campaignSupplierPayment.update({
      where: { campaignId },
      data: { status: "PROCESSING", releasedById: adminId, releasedAt: new Date(), holdReason: null },
    });
  },

  async holdSupplierPayment(adminId: string, campaignId: string, reason: string) {
    const payment = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId } });
    if (!payment) throw new AppError("No supplier payment record exists for this campaign", 404);
    if (payment.status === "PAID") throw new AppError("This payment has already been paid", 409);
    return prisma.campaignSupplierPayment.update({
      where: { campaignId },
      data: { status: "ON_HOLD", holdReason: reason },
    });
  },

  async listSupplierPaymentsForAdmin() {
    return prisma.campaignSupplierPayment.findMany({
      include: { campaign: { select: { id: true, title: true, confirmedShares: true } } },
      orderBy: { createdAt: "desc" },
    });
  },
};
