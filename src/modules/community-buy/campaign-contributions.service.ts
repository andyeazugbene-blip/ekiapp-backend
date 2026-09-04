import { LedgerAccountType, LedgerDirection, LedgerOwnerType } from "@prisma/client";
import type Stripe from "stripe";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { resolveStripeCurrency } from "../../shared/currency";
import { calculatePlatformFee } from "../../shared/pricing";
import { notificationsService } from "../notifications/notifications.service";
import { marketConfigurationService } from "./market-configuration.service";
import { supportCaseService } from "./support-case.service";
import { ledgerService } from "../ledger/ledger.service";
import { recordAudit } from "../../shared/utils/audit";

const SYSTEM_CRON_ACTOR = "system:cron";

/**
 * PLEDGE_THEN_CHARGE contribution flow — client mandate (2026-09): "Eki
 * never takes the fund upfront but participants are to give their payment
 * details so at end of the campaign payment go to the owner and Eki takes
 * its processing fee." Replaces the earlier pay-now/refund-on-failure model
 * (doc §9) end to end:
 *
 *   pledge()        -> saves a payment method reference + records the
 *                       pledge (status PLEDGED), claims capacity
 *                       atomically. NO Stripe charge happens here — only a
 *                       SetupIntent, already completed by the buyer through
 *                       the existing generic buyer/payment-methods flow
 *                       (payment-methods.service.ts, built for Regular
 *                       Deliveries — reused as-is, not duplicated).
 *   [campaign closes, GOAL_REACHED or MINIMUM_REACHED]
 *   chargeAllPledgesForCampaign() -> the ONLY place money is ever captured:
 *                       an off-session PaymentIntent per pledge, confirmed
 *                       synchronously (mirrors renewals.service.ts's
 *                       attemptPayment — the same "charge a saved card
 *                       while the buyer isn't present" pattern already
 *                       proven for Regular Deliveries).
 *   releaseSupplierPayment() -> admin-triggered (four-eyes gated in
 *                       community-buy.controller.ts), transfers the
 *                       collected total minus Eki's configured processing
 *                       fee to the supplier's Stripe Connect account.
 *
 * A campaign that never reaches its minimum never has any PAID
 * contribution to begin with (nothing was ever charged) — so
 * createRefundRecordsForFailedCampaign() (community-campaigns.service.ts)
 * naturally creates zero refunds for it, per the client's explicit rule:
 * "never invent refunds simply because a campaign failed." The refund
 * machinery below stays for the cases that genuinely need it: an
 * overcapacity race caught after a charge already succeeded, or an
 * admin-approved goodwill/dispute refund.
 */

const MAX_CHARGE_ATTEMPTS = 3;

interface PledgeResult {
  contributionId: string;
  quantity: number;
  amount: number;
  currency: string;
  status: string;
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

async function requirePaymentMethod(userId: string, paymentMethodId: string) {
  const paymentMethod = await prisma.buyerPaymentMethod.findUnique({ where: { id: paymentMethodId } });
  if (!paymentMethod || paymentMethod.buyerId !== userId) {
    throw new AppError("Payment method not found. Save a card before pledging.", 404, undefined, "PAYMENT_METHOD_NOT_FOUND");
  }
  return paymentMethod;
}

async function createPledge(
  campaignId: string,
  campaign: { pricePerShareMinor: number; currency: string },
  participantId: string,
  quantity: number,
  isOrganiserTopUp: boolean,
  paymentMethodId: string,
): Promise<PledgeResult> {
  const amount = quantity * campaign.pricePerShareMinor;

  // Atomic capacity claim — the pledge itself is the only commitment point
  // in this model (no Stripe call to arbitrate a race), so two concurrent
  // pledges for the last slot are decided entirely by this guarded UPDATE.
  const claimed = await prisma.$transaction(async (tx) => {
    const fresh = await tx.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    const maximum = fresh.maximumShares ?? 0;
    const maxConfirmedBefore = maximum - quantity;

    const claim = await tx.communityCampaign.updateMany({
      where: { id: campaignId, confirmedShares: { lte: maxConfirmedBefore } },
      data: { confirmedShares: { increment: quantity } },
    });
    if (claim.count !== 1) return null;

    const contribution = await tx.campaignContribution.create({
      data: { campaignId, participantId, amount, currency: campaign.currency, quantity, isOrganiserTopUp, status: "PLEDGED", paymentMethodId },
    });

    // First confirmed pledge locks the campaign's financial terms —
    // doc Screen 102 / spec §8.10.
    if (!fresh.termsLockedAt) {
      await tx.communityCampaign.update({ where: { id: campaignId }, data: { termsLockedAt: new Date() } });
    }
    return contribution;
  });

  if (!claimed) {
    const fresh = await prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    throw new AppError(
      `Only ${Math.max(0, (fresh.maximumShares ?? 0) - fresh.confirmedShares)} share(s) remain available.`,
      409,
      undefined,
      "CAPACITY_UNAVAILABLE",
    );
  }

  const contribution = await prisma.campaignContribution.findUniqueOrThrow({ where: { id: claimed.id }, include: { participant: true } });
  await notificationsService.enqueue({
    userId: contribution.participant.userId,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title: "Pledge recorded",
    body: "Your payment method is saved. You will only be charged if this campaign succeeds.",
    data: { type: "community_campaign_update", event: "pledge_recorded", campaignId },
  });

  return { contributionId: claimed.id, quantity, amount, currency: campaign.currency, status: "PLEDGED" };
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

  /**
   * Participant pledges a quantity against an already-saved payment method
   * (see buyer/payment-methods routes — the same SetupIntent flow Regular
   * Deliveries uses). No money moves here; only a pledge record and a
   * capacity claim.
   */
  async pledge(userId: string, campaignId: string, quantity: number, paymentMethodId: string): Promise<PledgeResult> {
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
    const paymentMethod = await requirePaymentMethod(userId, paymentMethodId);

    const participant = await prisma.campaignParticipant.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: {},
      create: { campaignId, userId },
    });

    return createPledge(campaignId, campaign, participant.id, quantity, false, paymentMethod.id);
  },

  /** Doc Screen 106 — organiser pledges the shortfall through the same flow, only while the campaign is in RESCUE_WINDOW. */
  async pledgeOrganiserTopUp(userId: string, campaignId: string, quantity: number, paymentMethodId: string): Promise<PledgeResult> {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !organiser || campaign.organiserId !== organiser.id) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "RESCUE_WINDOW") {
      throw new AppError("A top-up can only be pledged while the campaign is in its rescue window", 409);
    }

    const paymentsEnabled = await marketConfigurationService.isCommunityBuyPaymentsEnabled(campaign.country);
    if (!paymentsEnabled) {
      throw new AppError("Community Buy contributions are not yet enabled in this market.", 403);
    }

    assertContributableCampaign(campaign, quantity);
    await assertCapacityAvailable(campaign, quantity);
    const paymentMethod = await requirePaymentMethod(userId, paymentMethodId);

    const participant = await prisma.campaignParticipant.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: {},
      create: { campaignId, userId },
    });

    return createPledge(campaignId, campaign, participant.id, quantity, true, paymentMethod.id);
  },

  /**
   * The only place a Community Buy pledge is ever actually charged.
   * Off-session, confirmed synchronously — the result is read directly off
   * the returned PaymentIntent, never inferred from a client redirect
   * (there is no client present at all at this point). Idempotent per
   * attempt via "{contributionId}:{attemptNumber}", capped at
   * MAX_CHARGE_ATTEMPTS — mirrors renewals.service.ts's attemptPayment.
   */
  async attemptCharge(contributionId: string) {
    const contribution = await prisma.campaignContribution.findUniqueOrThrow({
      where: { id: contributionId },
      include: { participant: true, paymentMethod: true },
    });
    if (contribution.status === "PAID") return contribution; // idempotent — already charged.
    if (contribution.status !== "PLEDGED" && contribution.status !== "CHARGE_FAILED") {
      throw new AppError("This pledge is not ready to be charged", 409);
    }
    if (!contribution.paymentMethod) {
      return this.markChargeFailedTerminal(contribution, "No saved payment method on this pledge");
    }

    // Atomic claim — only one concurrent attemptCharge() call for this
    // contribution can win this guarded transition (e.g. a participant's
    // manual retry racing the cron sweep's post-success charge pass). A
    // loser bails out immediately instead of racing the winner to compute
    // its own attempt number and reaching Stripe with a second, distinct
    // idempotency key — which unlike a repeated key is NOT deduped by
    // Stripe and would genuinely double-charge the participant.
    const claim = await prisma.campaignContribution.updateMany({
      where: { id: contributionId, status: { in: ["PLEDGED", "CHARGE_FAILED"] } },
      data: { status: "PAYMENT_PROCESSING" },
    });
    if (claim.count !== 1) {
      return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contributionId } });
    }

    const priorAttempts = await prisma.campaignChargeAttempt.count({ where: { contributionId } });
    if (priorAttempts >= MAX_CHARGE_ATTEMPTS) {
      return this.markChargeFailedTerminal(contribution, "Maximum charge attempts exhausted");
    }
    const attemptNumber = priorAttempts + 1;
    const idempotencyKey = `${contributionId}:${attemptNumber}`;

    const attempt = await prisma.campaignChargeAttempt.create({ data: { contributionId, attemptNumber, status: "PENDING", idempotencyKey } });

    let intent: Stripe.PaymentIntent;
    try {
      if (resolveStripeCurrency(contribution.currency) !== contribution.currency.toLowerCase()) {
        throw new Error(`Card payments are not currently available in ${contribution.currency.toUpperCase()}.`);
      }
      intent = await stripe.paymentIntents.create(
        {
          amount: contribution.amount,
          currency: resolveStripeCurrency(contribution.currency),
          customer: contribution.paymentMethod.stripeCustomerId,
          payment_method: contribution.paymentMethod.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          metadata: { kind: "community_buy_pledge_charge", contributionId, campaignId: contribution.campaignId },
        },
        { idempotencyKey },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.campaignChargeAttempt.update({
        where: { id: attempt.id },
        data: { status: "FAILED", failureCode: (error as Stripe.StripeRawError)?.code, failureMessage: message },
      });
      return this.handleChargeAttemptFailure(contribution, message, attemptNumber >= MAX_CHARGE_ATTEMPTS);
    }

    if (intent.status === "succeeded") {
      await prisma.campaignChargeAttempt.update({ where: { id: attempt.id }, data: { status: "SUCCEEDED", stripePaymentIntentId: intent.id } });
      return this.markChargeSucceeded(contribution, intent.id);
    }

    if (intent.status === "processing") {
      // Delayed-notification payment method — genuinely unresolved, not a
      // failure. The contribution stays claimed in PAYMENT_PROCESSING (set
      // above) and the attempt stays PENDING, so the status guard at the
      // top of this method blocks any concurrent or later
      // attemptCharge()/retryCharge() call for this contribution — reopening
      // retry here would let a second, distinct Stripe idempotency key
      // double-charge the participant if this one later settles as
      // succeeded (spec §18.4/§18.5). The eventual payment_intent webhook
      // resolves it — see stripe.service.ts's handler for
      // metadata.kind === "community_buy_pledge_charge".
      await prisma.campaignChargeAttempt.update({
        where: { id: attempt.id },
        data: { stripePaymentIntentId: intent.id },
      });
      return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contributionId } });
    }

    // requires_action / anything else — an off-session charge with no
    // buyer present can't complete extra authentication.
    await prisma.campaignChargeAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", stripePaymentIntentId: intent.id, failureCode: intent.status, failureMessage: "Payment requires additional authentication" },
    });
    return this.handleChargeAttemptFailure(contribution, `Unexpected status: ${intent.status}`, attemptNumber >= MAX_CHARGE_ATTEMPTS);
  },

  /**
   * Resolves a pledge charge whose PaymentIntent was left "processing" by
   * attemptCharge() above, once Stripe's webhook reports the real outcome.
   * Idempotent: a non-PENDING attempt or a contribution already past
   * PAYMENT_PROCESSING means this already ran, so it's a safe no-op.
   */
  async resolveProcessingCharge(contributionId: string, stripePaymentIntentId: string, succeeded: boolean, failureMessage?: string) {
    const attempt = await prisma.campaignChargeAttempt.findFirst({
      where: { contributionId, stripePaymentIntentId },
    });
    if (!attempt || attempt.status !== "PENDING") return { handled: false as const };

    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      include: { participant: true },
    });
    if (!contribution || contribution.status !== "PAYMENT_PROCESSING") return { handled: false as const };

    if (succeeded) {
      // Same atomic-claim pattern as attemptCharge()'s claim above — the
      // conditional updateMany's count, not the findFirst read above, is
      // what actually proves this call won the transition, so a concurrent
      // duplicate resolution can never post the ledger entry twice.
      const claim = await prisma.campaignChargeAttempt.updateMany({
        where: { id: attempt.id, status: "PENDING" },
        data: { status: "SUCCEEDED" },
      });
      if (claim.count !== 1) return { handled: false as const };
      await this.markChargeSucceeded(contribution, stripePaymentIntentId);
      return { handled: true as const };
    }

    const claim = await prisma.campaignChargeAttempt.updateMany({
      where: { id: attempt.id, status: "PENDING" },
      data: { status: "FAILED", failureMessage: failureMessage ?? "Payment failed after processing" },
    });
    if (claim.count !== 1) return { handled: false as const };
    const priorAttempts = await prisma.campaignChargeAttempt.count({ where: { contributionId } });
    await this.handleChargeAttemptFailure(contribution, failureMessage ?? "Payment failed after processing", priorAttempts >= MAX_CHARGE_ATTEMPTS);
    return { handled: true as const };
  },

  async markChargeSucceeded(contribution: { id: string; campaignId: string; currency: string; amount: number; participant: { userId: string } }, stripePaymentIntentId: string) {
    await prisma.$transaction(async (tx) => {
      await tx.campaignContribution.update({ where: { id: contribution.id }, data: { status: "PAID", stripePaymentIntentId } });
      // Additive bookkeeping — money is genuinely captured by Stripe at
      // this point but doesn't belong to the supplier yet.
      // COMMUNITY_BUY_ESCROW is the platform-owned holding account until
      // releaseSupplierPayment() transfers it out net of Eki's fee.
      await ledgerService.postEntriesSafely(tx, {
        currency: contribution.currency,
        businessRefType: "CommunityContribution",
        businessRefId: contribution.id,
        providerRef: stripePaymentIntentId,
        description: `Community Buy pledge charged for campaign ${contribution.campaignId}`,
        legs: [
          { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: contribution.amount },
          { accountType: LedgerAccountType.COMMUNITY_BUY_ESCROW, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: contribution.amount },
        ],
      });
    });
    await notificationsService.enqueue({
      userId: contribution.participant.userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: "Payment confirmed",
      body: "This campaign succeeded — your saved card has been charged.",
      data: { type: "community_campaign_update", event: "pledge_charged", campaignId: contribution.campaignId },
    });
    return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contribution.id } });
  },

  async handleChargeAttemptFailure(contribution: { id: string; campaignId: string; participant: { userId: string } }, reason: string, exhausted: boolean) {
    if (exhausted) return this.markChargeFailedTerminal(contribution, reason);
    await prisma.campaignContribution.update({ where: { id: contribution.id }, data: { status: "CHARGE_FAILED" } });
    await notificationsService.enqueue({
      userId: contribution.participant.userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: "We couldn't collect your Community Buy payment",
      body: "Retry from the app to keep your place in this campaign.",
      data: { type: "community_campaign_update", event: "pledge_charge_failed", campaignId: contribution.campaignId },
    });
    return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contribution.id } });
  },

  async markChargeFailedTerminal(contribution: { id: string; campaignId: string; participant: { userId: string } }, reason: string) {
    logger.warn("Community Buy pledge charge failed terminally", { contributionId: contribution.id, campaignId: contribution.campaignId, reason });
    await prisma.campaignContribution.update({ where: { id: contribution.id }, data: { status: "CHARGE_FAILED" } });
    await notificationsService.enqueue({
      userId: contribution.participant.userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: "Payment could not be collected",
      body: "We couldn't collect payment for your Community Buy pledge after several attempts. Contact support to resolve this.",
      data: { type: "community_campaign_update", event: "pledge_charge_failed_final", campaignId: contribution.campaignId },
    });
    return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contribution.id } });
  },

  /**
   * Participant-triggered retry (e.g. after updating their card) — mirrors
   * renewalsService.retryPayment. attemptCharge() itself enforces the
   * MAX_CHARGE_ATTEMPTS cap, so this can never bypass it.
   */
  async retryCharge(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({ where: { id: contributionId }, include: { participant: true } });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    if (contribution.status !== "CHARGE_FAILED") throw new AppError("This pledge is not in a retryable state", 409);
    const result = await this.attemptCharge(contributionId);
    await this.syncSupplierPaymentAmount(contribution.campaignId);
    return result;
  },

  /**
   * Called once, right after a campaign succeeds (community-campaigns.
   * service.ts) — charges every PLEDGED contribution for that campaign.
   * Individual failures don't roll back others; each is independent
   * (client requirement: "each contribution handled independently").
   */
  async chargeAllPledgesForCampaign(campaignId: string): Promise<{ total: number; charged: number; failed: number }> {
    const pledged = await prisma.campaignContribution.findMany({ where: { campaignId, status: "PLEDGED" } });
    let charged = 0;
    let failed = 0;
    for (const contribution of pledged) {
      try {
        const result = await this.attemptCharge(contribution.id);
        if (result.status === "PAID") charged++;
        else failed++;
      } catch (error) {
        failed++;
        logger.error("Community Buy charge attempt threw unexpectedly", { contributionId: contribution.id, campaignId, error: String(error) });
      }
    }
    await this.syncSupplierPaymentAmount(campaignId);
    await recordAudit({
      actorId: SYSTEM_CRON_ACTOR,
      action: "community_campaign.charge_pledges",
      entityType: "CommunityCampaign",
      entityId: campaignId,
      metadata: { total: pledged.length, charged, failed },
    });
    return { total: pledged.length, charged, failed };
  },

  /**
   * Keeps CampaignSupplierPayment.amount in sync with what has actually
   * been collected — Eki can never transfer money it never received.
   * releaseSupplierPayment() also recomputes this live as a final
   * safety net, so a stale value here can never cause a bad transfer.
   */
  async syncSupplierPaymentAmount(campaignId: string): Promise<void> {
    const existing = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId } });
    if (!existing) return;
    const paidAgg = await prisma.campaignContribution.aggregate({ where: { campaignId, status: "PAID" }, _sum: { amount: true } });
    await prisma.campaignSupplierPayment.update({ where: { campaignId }, data: { amount: paidAgg._sum.amount ?? 0 } });
  },

  async getMyContribution(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      include: { participant: true, refund: true },
    });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    return contribution;
  },

  /** "My Community Buys" — every campaign this user has actually contributed to (paid or attempted), with their totals and any refund status for that campaign. */
  async listMyContributions(userId: string) {
    const participants = await prisma.campaignParticipant.findMany({
      where: { userId },
      include: {
        campaign: {
          select: {
            id: true, title: true, status: true, fundingOutcome: true, currency: true, deadline: true,
            supplier: { select: { vendor: { select: { storeName: true } } } },
          },
        },
        contributions: {
          where: { status: { not: "INITIATED" } },
          include: { refund: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { joinedAt: "desc" },
    });

    return participants
      .filter((p) => p.contributions.length > 0)
      .map((p) => {
        const paid = p.contributions.filter((c) => c.status === "PAID");
        const pledged = p.contributions.filter((c) => c.status === "PLEDGED" || c.status === "PAYMENT_PROCESSING" || c.status === "CHARGE_FAILED");
        const refunds = p.contributions.map((c) => c.refund).filter((r): r is NonNullable<typeof r> => r != null);
        return {
          campaign: p.campaign,
          totalQuantity: paid.reduce((sum, c) => sum + c.quantity, 0),
          totalPaid: paid.reduce((sum, c) => sum + c.amount, 0),
          totalPledged: pledged.reduce((sum, c) => sum + c.amount, 0),
          latestContribution: p.contributions[0],
          refundStatus: refunds.find((r) => r.status === "REFUND_FAILED")?.status
            ?? refunds.find((r) => r.status === "REFUND_PENDING" || r.status === "REFUND_PROCESSING")?.status
            ?? refunds.find((r) => r.status === "REFUNDED")?.status
            ?? null,
        };
      });
  },

  // ─── Refunds — doc §10 ──────────────────────────────────────────────────
  // Under PLEDGE_THEN_CHARGE, a failed campaign never has a PAID
  // contribution to refund in the first place (see file header). This
  // machinery now only ever fires for a charge that succeeded and later
  // genuinely needs reversing (overcapacity race, admin-approved goodwill
  // refund) — never invented just because a campaign failed.

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

  /**
   * spec §130 "Recheck provider status" — for a refund that failed or is
   * still pending, re-attempts the Stripe refund with the SAME
   * idempotencyKey already stored on the record. Stripe's idempotency
   * guarantee means this can never create a second, duplicate refund: if
   * one already exists under that key, Stripe just returns it.
   */
  async requeryRefund(refundId: string) {
    const refund = await prisma.campaignRefund.findUnique({
      where: { id: refundId },
      include: { contribution: { include: { participant: true } } },
    });
    if (!refund) throw new AppError("Refund not found", 404);
    if (refund.status === "REFUNDED") return refund; // already settled — nothing to recheck

    try {
      if (!refund.contribution.stripePaymentIntentId) throw new Error("Contribution has no payment intent to refund");
      const stripeRefund = await stripe.refunds.create(
        { payment_intent: refund.contribution.stripePaymentIntentId, amount: refund.amount },
        { idempotencyKey: refund.idempotencyKey },
      );
      const updated = await prisma.campaignRefund.update({
        where: { id: refundId },
        data: { status: "REFUNDED", stripeRefundId: stripeRefund.id, failureReason: null },
      });
      await prisma.campaignContribution.update({ where: { id: refund.contributionId }, data: { status: "REFUNDED" } });
      await ledgerService.reverseEntries(prisma, {
        businessRefType: "CommunityContribution",
        businessRefId: refund.contributionId,
        providerRef: stripeRefund.id,
        description: `Refund reverses Community Buy contribution ${refund.contributionId}`,
      }).catch((error) => {
        logger.error("Ledger reversal failed for Community Buy refund (non-fatal — refund already completed)", { refundId, errorMessage: error instanceof Error ? error.message : String(error) });
      });
      await notificationsService.enqueue({
        userId: refund.contribution.participant.userId,
        type: "COMMUNITY_CAMPAIGN_UPDATE",
        title: "Refund completed",
        body: "Your Community Buy refund has been completed.",
        data: { type: "community_campaign_update", event: "refund_completed", campaignId: refund.contribution.campaignId },
      }).catch(() => {});
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return prisma.campaignRefund.update({ where: { id: refundId }, data: { status: "REFUND_FAILED", failureReason: message } });
    }
  },

  /**
   * spec §130 "Escalate" — reuses the existing Community Buy support-case
   * system (support-case.service.ts) rather than inventing a parallel
   * escalation mechanism. The case is opened on behalf of the affected
   * participant (who genuinely does have a relationship to the campaign)
   * and immediately marked escalated by the admin.
   */
  async escalateRefund(adminId: string, refundId: string, note?: string) {
    const refund = await prisma.campaignRefund.findUnique({
      where: { id: refundId },
      include: { contribution: { include: { participant: true, campaign: true } } },
    });
    if (!refund) throw new AppError("Refund not found", 404);

    const supportCase = await supportCaseService.create(refund.contribution.participant.userId, refund.contribution.campaignId, {
      caseType: "REFUND_ISSUE",
      description: note?.trim() || `Refund ${refund.id} for ${refund.contribution.campaign.title} needs attention (status: ${refund.status}${refund.failureReason ? `, reason: ${refund.failureReason}` : ""}).`,
    });
    return supportCaseService.adminUpdate(adminId, supportCase.id, { escalated: true });
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
        await recordAudit({
          actorId: SYSTEM_CRON_ACTOR,
          action: "community_refund.processed",
          entityType: "CampaignRefund",
          entityId: refund.id,
          metadata: { amount: refund.amount, stripeRefundId: stripeRefund.id },
        });
        await ledgerService.reverseEntries(prisma, {
          businessRefType: "CommunityContribution",
          businessRefId: refund.contributionId,
          providerRef: stripeRefund.id,
          description: `Refund reverses Community Buy contribution ${refund.contributionId}`,
        }).catch((ledgerError) => {
          logger.error("Ledger reversal failed for Community Buy refund (non-fatal — refund already completed)", { refundId: refund.id, errorMessage: ledgerError instanceof Error ? ledgerError.message : String(ledgerError) });
        });
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

  /** Supplier's own read-only view of their payment for one campaign — never exposes other suppliers' records. */
  async getMyPaymentForCampaign(vendorId: string, campaignId: string) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !supplier || campaign.supplierId !== supplier.id) {
      throw new AppError("Campaign not found", 404);
    }
    const payment = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId } });
    if (!payment) throw new AppError("No supplier payment record exists for this campaign yet", 404);
    return payment;
  },

  /**
   * The actual settlement — client mandate: "owner receives the campaign
   * funds through the approved Stripe flow, while Eki takes its configured
   * processing fee." Always recomputes the collected total live from PAID
   * contributions (never trusts the stored estimate) and requires an
   * explicit per-market fee before it will move a single cent — no
   * invented default percentage.
   */
  async releaseSupplierPayment(adminId: string, campaignId: string) {
    const payment = await prisma.campaignSupplierPayment.findUnique({
      where: { campaignId },
      include: { campaign: { include: { supplier: { include: { vendor: true } } } } },
    });
    if (!payment) throw new AppError("No supplier payment record exists for this campaign", 404);
    if (payment.status === "PAID") return payment;
    if (payment.status !== "NOT_RELEASED" && payment.status !== "ON_HOLD") {
      throw new AppError("This payment cannot be released from its current state", 409);
    }
    // Doc Screen 131: never release if the payout account changed after
    // campaign approval without reverification.
    const vendor = payment.campaign.supplier.vendor;
    if (payment.payoutStripeAccountIdAtApproval && vendor.stripeAccountId !== payment.payoutStripeAccountIdAtApproval) {
      throw new AppError("The supplier's payout account has changed since approval — reverification is required before release", 409, undefined, "PAYOUT_ACCOUNT_CHANGED");
    }
    if (!vendor.stripeAccountId || !vendor.stripePayoutsEnabled) {
      throw new AppError("This supplier's payout account is not ready to receive transfers", 409, undefined, "PAYOUTS_NOT_ENABLED");
    }

    const paidAgg = await prisma.campaignContribution.aggregate({ where: { campaignId, status: "PAID" }, _sum: { amount: true } });
    const totalPaid = paidAgg._sum.amount ?? 0;
    if (totalPaid <= 0) {
      throw new AppError("No contributions have been successfully charged for this campaign yet", 409, undefined, "NOTHING_COLLECTED_YET");
    }

    const config = await marketConfigurationService.get(payment.campaign.country);
    if (config?.communityBuyFeeBps == null) {
      throw new AppError("This market has no configured Community Buy processing fee — set one before releasing supplier payments", 409, undefined, "FEE_NOT_CONFIGURED");
    }
    const feeAmount = calculatePlatformFee(totalPaid, config.communityBuyFeeBps);
    const netAmount = totalPaid - feeAmount;

    await prisma.campaignSupplierPayment.update({
      where: { campaignId },
      data: { status: "PROCESSING", amount: totalPaid, feeAmount, netAmount },
    });

    let transfer: Stripe.Transfer;
    try {
      transfer = await stripe.transfers.create(
        {
          amount: netAmount,
          currency: resolveStripeCurrency(payment.currency),
          destination: vendor.stripeAccountId,
          transfer_group: `community-buy:${campaignId}`,
          description: `Community Buy settlement for campaign ${campaignId}`,
        },
        { idempotencyKey: `community-buy-transfer:${campaignId}` },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.campaignSupplierPayment.update({ where: { campaignId }, data: { status: "ON_HOLD", holdReason: `Transfer failed: ${message}` } });
      throw new AppError(`Supplier transfer failed: ${message}`, 502);
    }

    const updated = await prisma.campaignSupplierPayment.update({
      where: { campaignId },
      data: { status: "PAID", releasedById: adminId, releasedAt: new Date(), stripeTransferId: transfer.id, holdReason: null },
    });

    await ledgerService.postEntriesSafely(prisma, {
      currency: payment.currency,
      businessRefType: "CampaignSupplierPayment",
      businessRefId: payment.id,
      providerRef: transfer.id,
      description: `Community Buy settlement for campaign ${campaignId} — supplier net of Eki processing fee`,
      legs: [
        { accountType: LedgerAccountType.COMMUNITY_BUY_ESCROW, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: totalPaid },
        { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: vendor.id, direction: LedgerDirection.CREDIT, amount: netAmount },
        { accountType: LedgerAccountType.PLATFORM_FEE_REVENUE, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: feeAmount },
      ],
    }).catch((error) => {
      logger.error("Ledger posting failed for Community Buy supplier settlement (non-fatal — transfer already completed)", { campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
    });

    return updated;
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

  // ─── Financial ledger (read-only) — doc §12 Ledger Structure ───────────
  // Every row here is derived directly from money that has actually moved
  // (a PAID contribution, a REFUNDED refund, a PAID supplier payment) —
  // never invented, projected, or estimated. Eki holds no custody of these
  // funds beyond the brief escrow window between charge and settlement
  // transfer; this is a reconciliation view over Stripe-settled events.

  /** One row per campaign that has had at least one financial event, for the admin ledger overview list. */
  async getLedgerSummaryForAdmin() {
    const [contributions, refunds, supplierPayments] = await Promise.all([
      prisma.campaignContribution.groupBy({
        by: ["campaignId"],
        where: { status: "PAID" },
        _sum: { amount: true },
        _count: { id: true },
      }),
      prisma.campaignRefund.groupBy({
        by: ["contributionId"],
        where: { status: "REFUNDED" },
        _sum: { amount: true },
      }),
      prisma.campaignSupplierPayment.findMany({
        where: { status: "PAID" },
        select: { campaignId: true, amount: true },
      }),
    ]);

    // Refunds group by contributionId, not campaignId — resolve back to campaign.
    const refundedContributionIds = refunds.map((r) => r.contributionId);
    const refundedContributions = refundedContributionIds.length
      ? await prisma.campaignContribution.findMany({
          where: { id: { in: refundedContributionIds } },
          select: { id: true, campaignId: true },
        })
      : [];
    const campaignIdByContributionId = new Map(refundedContributions.map((c) => [c.id, c.campaignId]));
    const refundedByCampaign = new Map<string, number>();
    for (const r of refunds) {
      const campaignId = campaignIdByContributionId.get(r.contributionId);
      if (!campaignId) continue;
      refundedByCampaign.set(campaignId, (refundedByCampaign.get(campaignId) ?? 0) + (r._sum.amount ?? 0));
    }

    const supplierPaidByCampaign = new Map<string, number>();
    for (const p of supplierPayments) {
      supplierPaidByCampaign.set(p.campaignId, (supplierPaidByCampaign.get(p.campaignId) ?? 0) + p.amount);
    }

    const campaignIds = new Set<string>([
      ...contributions.map((c) => c.campaignId),
      ...refundedByCampaign.keys(),
      ...supplierPaidByCampaign.keys(),
    ]);
    if (campaignIds.size === 0) return [];

    const campaigns = await prisma.communityCampaign.findMany({
      where: { id: { in: [...campaignIds] } },
      select: { id: true, title: true, currency: true, status: true, fundingOutcome: true },
    });
    const campaignById = new Map(campaigns.map((c) => [c.id, c]));
    const contributedByCampaign = new Map(contributions.map((c) => [c.campaignId, { total: c._sum.amount ?? 0, count: c._count.id }]));

    return [...campaignIds].map((campaignId) => {
      const campaign = campaignById.get(campaignId);
      const totalContributed = contributedByCampaign.get(campaignId)?.total ?? 0;
      const totalRefunded = refundedByCampaign.get(campaignId) ?? 0;
      const totalPaidToSupplier = supplierPaidByCampaign.get(campaignId) ?? 0;
      return {
        campaignId,
        title: campaign?.title ?? "(deleted campaign)",
        currency: campaign?.currency ?? "GBP",
        status: campaign?.status ?? null,
        fundingOutcome: campaign?.fundingOutcome ?? null,
        contributionCount: contributedByCampaign.get(campaignId)?.count ?? 0,
        totalContributed,
        totalRefunded,
        totalPaidToSupplier,
        netPosition: totalContributed - totalRefunded - totalPaidToSupplier,
      };
    });
  },

  /** Itemized ledger for one campaign — every PAID contribution, REFUNDED refund, and PAID supplier payment, in order. */
  async getCampaignLedger(campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, title: true, currency: true, status: true, fundingOutcome: true },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);

    const [contributions, refunds, supplierPayment] = await Promise.all([
      prisma.campaignContribution.findMany({
        where: { campaignId, status: "PAID" },
        include: { participant: { include: { user: { select: { name: true, email: true } } } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.campaignRefund.findMany({
        where: { status: "REFUNDED", contribution: { campaignId } },
        include: { contribution: { include: { participant: { include: { user: { select: { name: true, email: true } } } } } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.campaignSupplierPayment.findUnique({ where: { campaignId } }),
    ]);

    type LedgerEntry = {
      id: string;
      type: "CONTRIBUTION" | "REFUND" | "SUPPLIER_PAYMENT";
      direction: "CREDIT" | "DEBIT";
      amount: number;
      occurredAt: Date;
      description: string;
    };

    const entries: LedgerEntry[] = [];
    for (const c of contributions) {
      entries.push({
        id: c.id,
        type: "CONTRIBUTION",
        direction: "CREDIT",
        amount: c.amount,
        occurredAt: c.updatedAt,
        description: c.isOrganiserTopUp
          ? `Organiser top-up · ${c.participant.user.name}`
          : `Contribution (${c.quantity} share${c.quantity === 1 ? "" : "s"}) · ${c.participant.user.name}`,
      });
    }
    for (const r of refunds) {
      entries.push({
        id: r.id,
        type: "REFUND",
        direction: "DEBIT",
        amount: r.amount,
        occurredAt: r.updatedAt,
        description: `Refund · ${r.contribution.participant.user.name}`,
      });
    }
    if (supplierPayment && supplierPayment.status === "PAID") {
      entries.push({
        id: supplierPayment.id,
        type: "SUPPLIER_PAYMENT",
        direction: "DEBIT",
        amount: supplierPayment.amount,
        occurredAt: supplierPayment.updatedAt,
        description: "Supplier payment released",
      });
    }
    entries.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    const totalContributed = contributions.reduce((sum, c) => sum + c.amount, 0);
    const totalRefunded = refunds.reduce((sum, r) => sum + r.amount, 0);
    const totalPaidToSupplier = supplierPayment?.status === "PAID" ? supplierPayment.amount : 0;

    return {
      campaign,
      entries,
      totals: {
        totalContributed,
        totalRefunded,
        totalPaidToSupplier,
        netPosition: totalContributed - totalRefunded - totalPaidToSupplier,
      },
    };
  },
};
