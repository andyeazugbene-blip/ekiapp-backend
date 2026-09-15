import { LedgerAccountType, LedgerDirection, LedgerOwnerType } from "@prisma/client";
import type Stripe from "stripe";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { resolveStripeCurrency } from "../../shared/currency";
import { calculatePlatformFee } from "../../shared/pricing";
import { notificationsService } from "../notifications/notifications.service";
import { ledgerService } from "../ledger/ledger.service";
import { recordAudit } from "../../shared/utils/audit";
import { marketConfigurationService } from "./market-configuration.service";

const SYSTEM_CRON_ACTOR = "system:cron";
const CONSENT_WORDING_VERSION = "cb-authorise-v1";

// spec 9.3 — participant recovery window after a declined/requires_action
// hold. spec 12/17.2's payment_recovery_timeout job expires it.
const HOLD_RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;

// spec AT-11/AT-13 — organiser's below-minimum proceed/cancel window.
const DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;

// spec 10.5 — "Recommended defaults are a maximum 12-hour supplier
// response period and at least six safe hours before capture expiry."
const RECONFIRMATION_MAX_MS = 12 * 60 * 60 * 1000;
const RECONFIRMATION_SAFETY_BUFFER_MS = 6 * 60 * 60 * 1000;

// M2 plan §J item 3 — Stripe's PaymentIntent API reliability for a
// per-hold, card-network-specific "capture by" timestamp has NOT been
// verified (spec 11.3 step 4-5 explicitly requires reading the REAL
// provider value, "never assume seven days"). markHoldSucceeded() below
// therefore leaves captureBefore null whenever Stripe doesn't return a
// usable value, rather than defaulting to a guessed number. This fallback
// buffer is what hold_expiry_monitor uses ONLY as a last resort when
// captureBefore is still null — it is an explicitly-flagged engineering
// default, not a verified Stripe fact, and is intentionally set to a
// different number than the commonly-cited "~7 days" so it can never be
// mistaken for one.
const HOLD_EXPIRY_FALLBACK_WARNING_MS = 5 * 24 * 60 * 60 * 1000;
const HOLD_EXPIRY_WARNING_BUFFER_MS = 24 * 60 * 60 * 1000;

type AuthorisationRecord = {
  id: string;
  contributionId: string;
  campaignId: string;
  supplierConnectedAccountId: string;
  setupIntentId: string;
  paymentMethodReference: string;
  paymentIntentId: string | null;
  consentedChargeAmount: number;
  consentCurrency: string;
  authorisedAmount: number | null;
  holdStatus: string;
  captureStatus: string;
  retryCount: number;
  idempotencyKey: string;
};

/**
 * M2 — AUTHORISE_THEN_CAPTURE payment flow (spec §11). Sibling to
 * campaign-contributions.service.ts's PLEDGE_THEN_CHARGE flow — the two
 * never share a code path beyond CampaignContribution itself (see that
 * model's own doc comment on CommunityBuyPaymentAuthorisation).
 *
 * Stripe Connect DIRECT CHARGES, not Separate Charges and Transfers (the
 * only Connect pattern that existed anywhere in this codebase before this
 * file — campaign-contributions.service.ts's releaseSupplierPayment() —
 * which spec §13.3 explicitly forbids continuing for this mode). A Direct
 * Charge requires the Customer/PaymentMethod to exist in the SAME
 * connected-account context as the charge (a Stripe platform requirement,
 * not a choice made here), which is why every SetupIntent/PaymentIntent
 * below is created with `{ stripeAccount: <supplier's connected account> }`
 * — and why this deliberately does NOT reuse BuyerPaymentMethod (a
 * platform-account customer/PM shared across Regular Deliveries and the
 * old Community Buy mode). A participant backing two different suppliers'
 * campaigns gets two separate, connected-account-scoped payment methods,
 * even for the same physical card — this is exactly why spec invariant #9
 * requires a fresh SetupIntent on supplier replacement, not an arbitrary
 * rule.
 *
 * Fee handling: `application_fee_amount` on the manual-capture PaymentIntent
 * splits funds in the SAME Stripe call that captures the hold — the
 * supplier's net share lands in THEIR OWN connected account automatically;
 * there is no second "transfer" call for the captured amount the way the
 * old mode's releaseSupplierPayment() needs one. See campaign-payout.
 * service.ts for what that means (and does NOT mean) for payout custody.
 */

function isAuthoriseCampaign(campaign: { paymentMode: string }): void {
  if (campaign.paymentMode !== "AUTHORISE_THEN_CAPTURE") {
    throw new AppError("This campaign is not using the authorise-then-capture payment model", 409);
  }
}

/** Dual-path resolver mirroring createSupplierOrder()/releaseSupplierPayment()'s existing SupplierAccount-vs-legacy-Vendor pattern — never shared code with those, just the same shape. */
async function resolveCampaignConnectedAccountId(campaign: { fulfilmentOwner: string; supplierAccountId: string | null; supplierId: string | null }): Promise<string | null> {
  if (campaign.fulfilmentOwner !== "SUPPLIER") return null; // SELF-fulfilment has no connected account — see submit()'s guard preventing this combination.
  if (campaign.supplierAccountId) {
    const account = await prisma.supplierAccount.findUnique({ where: { id: campaign.supplierAccountId }, select: { providerConnectedAccountId: true } });
    return account?.providerConnectedAccountId ?? null;
  }
  if (campaign.supplierId) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId }, include: { vendor: { select: { stripeAccountId: true } } } });
    return supplier?.vendor.stripeAccountId ?? null;
  }
  return null;
}

/** Resolves the ledger owner (SupplierAccount.id or legacy Vendor.id) for SUPPLIER_PAYABLE/SUPPLIER_CONNECTED_BALANCE legs — same dual-path shape as resolveCampaignConnectedAccountId(). */
async function resolveCampaignSupplierLedgerOwnerId(campaign: { supplierAccountId: string | null; supplierId: string | null }): Promise<string | null> {
  if (campaign.supplierAccountId) return campaign.supplierAccountId;
  if (campaign.supplierId) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId }, select: { vendorId: true } });
    return supplier?.vendorId ?? null;
  }
  return null;
}

function nextHoldIdempotencyKey(contributionId: string, retryCount: number): string {
  return `hold:${contributionId}:${retryCount + 1}`;
}

async function notifyParticipant(userId: string, event: string, title: string, body: string, campaignId: string): Promise<void> {
  try {
    await notificationsService.enqueue({
      userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title,
      body,
      data: { type: "community_campaign_update", event, campaignId },
    });
  } catch (error) {
    logger.error("Community Buy authorisation notification failed (non-blocking)", { event, campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

export const campaignAuthorisationService = {
  // ─── Commitment (spec §11.2) ────────────────────────────────────────────

  /**
   * spec §16 "POST /community-buys/:id/commit" — deliberately a SEPARATE
   * endpoint/service function from campaign-contributions.service.ts's
   * pledge(), not a branch inside it: that function's controller-level
   * request validation hard-requires a paymentMethodId (an existing
   * BuyerPaymentMethod) up front, which has no equivalent here (the real
   * PaymentMethod doesn't exist until the SetupIntent below is confirmed
   * client-side). Splitting the endpoint keeps pledge() and its 194
   * existing tests completely untouched.
   */
  async commit(userId: string, campaignId: string, quantity: number): Promise<{ contributionId: string; quantity: number; amount: number; currency: string; status: string; setupIntentClientSecret: string | null }> {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== "LIVE" || !campaign.country || !campaign.deadline) {
      throw new AppError("Campaign not found or not live", 404);
    }
    isAuthoriseCampaign(campaign);
    if (new Date() >= campaign.deadline) throw new AppError("This campaign is no longer accepting contributions", 409);

    const paymentsEnabled = await marketConfigurationService.isCommunityBuyPaymentsEnabled(campaign.country);
    if (!paymentsEnabled) {
      throw new AppError("Community Buy contributions are not yet enabled in this market.", 403);
    }
    if (!campaign.pricePerShareMinor) throw new AppError("This campaign has no price configured", 409);
    if (!campaign.currency) throw new AppError("Campaign not found or not live", 404);
    if (resolveStripeCurrency(campaign.currency) !== campaign.currency.toLowerCase()) {
      throw new AppError(`Contributions are not currently available in ${campaign.currency.toUpperCase()}.`, 400, undefined, "CURRENCY_NOT_SUPPORTED");
    }

    const connectedAccountId = await resolveCampaignConnectedAccountId(campaign);
    if (!connectedAccountId) {
      throw new AppError("This campaign's supplier has not completed Stripe Connect onboarding yet", 409, undefined, "SUPPLIER_NOT_PAYOUT_READY");
    }

    const maximum = campaign.maximumShares ?? 0;
    if (campaign.confirmedShares + quantity > maximum) {
      throw new AppError(`Only ${Math.max(0, maximum - campaign.confirmedShares)} share(s) remain available.`, 409, undefined, "CAPACITY_UNAVAILABLE");
    }
    const amount = quantity * campaign.pricePerShareMinor;

    const participant = await prisma.campaignParticipant.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: {},
      create: { campaignId, userId },
    });

    // Atomic capacity claim — mirrors createPledge()'s guarded-transaction
    // shape exactly (same reasoning: this claim IS the only commitment
    // point, so a race for the last slot is decided by this guarded UPDATE
    // alone, not by anything Stripe-side).
    const claimed = await prisma.$transaction(async (tx) => {
      const fresh = await tx.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
      const maxConfirmedBefore = (fresh.maximumShares ?? 0) - quantity;
      const claim = await tx.communityCampaign.updateMany({
        where: { id: campaignId, confirmedShares: { lte: maxConfirmedBefore } },
        data: { confirmedShares: { increment: quantity } },
      });
      if (claim.count !== 1) return null;
      const contribution = await tx.campaignContribution.create({
        data: { campaignId, participantId: participant.id, amount, currency: campaign.currency!, quantity, isOrganiserTopUp: false, status: "PLEDGED", paymentMethodId: null },
      });
      if (!fresh.termsLockedAt) {
        await tx.communityCampaign.update({ where: { id: campaignId }, data: { termsLockedAt: new Date() } });
      }
      return contribution;
    });
    if (!claimed) {
      const fresh = await prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
      throw new AppError(`Only ${Math.max(0, (fresh.maximumShares ?? 0) - fresh.confirmedShares)} share(s) remain available.`, 409, undefined, "CAPACITY_UNAVAILABLE");
    }

    // spec §11.2: create the SetupIntent IN the connected-account context;
    // persist references; do NOT populate authorised_amount; do NOT write
    // ledger events.
    const setupIntent = await stripe.setupIntents.create(
      { payment_method_types: ["card"], usage: "off_session", metadata: { kind: "community_buy_hold_setup", contributionId: claimed.id, campaignId } },
      { stripeAccount: connectedAccountId, idempotencyKey: `setup:${claimed.id}` },
    );

    await prisma.communityBuyPaymentAuthorisation.create({
      data: {
        contributionId: claimed.id,
        campaignId,
        supplierConnectedAccountId: connectedAccountId,
        setupIntentId: setupIntent.id,
        paymentMethodReference: "", // filled in by confirmSetup() once the participant completes the SetupIntent client-side
        consentedAt: new Date(),
        consentWordingVersion: CONSENT_WORDING_VERSION,
        consentedChargeAmount: amount,
        consentCurrency: campaign.currency,
        holdStatus: "NOT_REQUESTED",
        idempotencyKey: `hold:${claimed.id}:0`, // attempt-0 sentinel, never sent to Stripe — createHold() overwrites this before the first real attempt
      },
    });

    await notifyParticipant(userId, "commitment_recorded", "Commitment recorded", "Save your card to complete your commitment. You will not be charged today.", campaignId);

    return { contributionId: claimed.id, quantity, amount, currency: campaign.currency, status: "PLEDGED", setupIntentClientSecret: setupIntent.client_secret };
  },

  /** Participant confirms the connected-account SetupIntent client-side, then calls this to attach the resulting PaymentMethod reference. Idempotent. */
  async confirmSetup(userId: string, contributionId: string) {
    const authorisation = await prisma.communityBuyPaymentAuthorisation.findUnique({
      where: { contributionId },
      include: { contribution: { include: { participant: true } } },
    });
    if (!authorisation || authorisation.contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    if (authorisation.paymentMethodReference) return authorisation; // already confirmed

    const setupIntent = await stripe.setupIntents.retrieve(authorisation.setupIntentId, { stripeAccount: authorisation.supplierConnectedAccountId });
    if (setupIntent.status !== "succeeded" || !setupIntent.payment_method) {
      throw new AppError("Card setup has not completed yet", 409);
    }
    const paymentMethodReference = typeof setupIntent.payment_method === "string" ? setupIntent.payment_method : setupIntent.payment_method.id;
    return prisma.communityBuyPaymentAuthorisation.update({ where: { contributionId }, data: { paymentMethodReference } });
  },

  /** spec §16 "POST /community-buys/:id/withdraw" — only before a hold exists; once one does, it's a release (cancelHold), never a plain withdrawal. */
  async withdraw(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      include: { participant: true, paymentAuthorisation: true, campaign: true },
    });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    if (contribution.campaign.paymentMode !== "AUTHORISE_THEN_CAPTURE") throw new AppError("Withdrawal is not available for this campaign", 409);
    if (contribution.status !== "PLEDGED") throw new AppError("This pledge can no longer be withdrawn", 409);
    if (contribution.paymentAuthorisation && contribution.paymentAuthorisation.holdStatus !== "NOT_REQUESTED") {
      throw new AppError("A hold already exists for this pledge — it can only be released, not withdrawn", 409);
    }

    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.campaignContribution.updateMany({ where: { id: contributionId, status: "PLEDGED" }, data: { status: "CANCELLED" } });
      if (claim.count !== 1) return false;
      await tx.communityCampaign.update({ where: { id: contribution.campaignId }, data: { confirmedShares: { decrement: contribution.quantity } } });
      if (contribution.paymentAuthorisation) {
        await tx.communityBuyPaymentAuthorisation.update({ where: { id: contribution.paymentAuthorisation.id }, data: { holdStatus: "HOLD_RELEASED" } });
      }
      return true;
    });
    if (!claimed) throw new AppError("This pledge can no longer be withdrawn", 409);
    return prisma.campaignContribution.findUniqueOrThrow({ where: { id: contributionId } });
  },

  // ─── Hold window (spec §11.3) ───────────────────────────────────────────

  /** open_hold_windows job — moves LIVE->HOLD_WINDOW at the deadline is done in community-campaigns.service.ts's closeDueCampaigns(); this creates the actual holds once holdWindowStartsAt has passed for a campaign already in HOLD_WINDOW. */
  async openHoldWindows(): Promise<{ campaignsProcessed: number; holdsCreated: number }> {
    const due = await prisma.communityCampaign.findMany({
      where: { status: "HOLD_WINDOW", paymentMode: "AUTHORISE_THEN_CAPTURE", holdWindowStartsAt: { lte: new Date() } },
    });
    let holdsCreated = 0;
    for (const campaign of due) {
      const pending = await prisma.communityBuyPaymentAuthorisation.findMany({ where: { campaignId: campaign.id, holdStatus: "NOT_REQUESTED" } });
      for (const authorisation of pending) {
        await this.createHold(authorisation.id);
        holdsCreated++;
      }
    }
    return { campaignsProcessed: due.length, holdsCreated };
  },

  /** Creates (or retries) the manual-capture PaymentIntent for one authorisation. Guarded-claim-before-Stripe-call, same discipline as attemptCharge() in the old mode. */
  async createHold(authorisationId: string) {
    const authorisation = await prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
    if (!["NOT_REQUESTED", "HOLD_DECLINED"].includes(authorisation.holdStatus)) {
      return authorisation; // idempotent — already attempted/succeeded/etc.
    }
    if (!authorisation.paymentMethodReference) {
      return this.markHoldDeclined(authorisation, "Card setup was never completed", "no_payment_method_confirmed");
    }

    const idempotencyKey = nextHoldIdempotencyKey(authorisation.contributionId, authorisation.retryCount);
    const claim = await prisma.communityBuyPaymentAuthorisation.updateMany({
      where: { id: authorisationId, holdStatus: { in: ["NOT_REQUESTED", "HOLD_DECLINED"] } },
      data: { holdStatus: "HOLD_PENDING", idempotencyKey, retryCount: { increment: 1 } },
    });
    if (claim.count !== 1) return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });

    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: authorisation.consentedChargeAmount,
          currency: resolveStripeCurrency(authorisation.consentCurrency),
          payment_method: authorisation.paymentMethodReference,
          confirm: true,
          off_session: true,
          capture_method: "manual",
          metadata: { kind: "community_buy_hold", authorisationId: authorisation.id, contributionId: authorisation.contributionId, campaignId: authorisation.campaignId },
        },
        { stripeAccount: authorisation.supplierConnectedAccountId, idempotencyKey },
      );
    } catch (error) {
      const stripeErr = error as { type?: string; code?: string };
      const message = error instanceof Error ? error.message : String(error);
      if (stripeErr.type === "StripeConnectionError" || stripeErr.type === "StripeAPIError") {
        // Ambiguous — leave HOLD_PENDING; requeryAmbiguousHold() replays the
        // SAME idempotencyKey (same reasoning as attemptCharge()'s identical
        // branch in the old mode).
        await prisma.communityBuyPaymentAuthorisation.update({ where: { id: authorisationId }, data: { providerErrorCode: stripeErr.code ?? null } });
        return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
      }
      return this.markHoldDeclined(authorisation, message, stripeErr.code);
    }

    return this.applyHoldIntentResult(authorisation, intent);
  },

  /** Reliability recovery path (mirrors requeryAmbiguousCharge()) — replays the SAME idempotencyKey; Stripe guarantees this is safe even if the original request actually reached it. */
  async requeryAmbiguousHold(authorisationId: string): Promise<{ handled: boolean }> {
    const authorisation = await prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
    if (authorisation.holdStatus !== "HOLD_PENDING" || !authorisation.paymentMethodReference) return { handled: false };
    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: authorisation.consentedChargeAmount,
          currency: resolveStripeCurrency(authorisation.consentCurrency),
          payment_method: authorisation.paymentMethodReference,
          confirm: true,
          off_session: true,
          capture_method: "manual",
          metadata: { kind: "community_buy_hold", authorisationId: authorisation.id, contributionId: authorisation.contributionId, campaignId: authorisation.campaignId },
        },
        { stripeAccount: authorisation.supplierConnectedAccountId, idempotencyKey: authorisation.idempotencyKey },
      );
    } catch {
      return { handled: false };
    }
    await this.applyHoldIntentResult(authorisation, intent);
    return { handled: true };
  },

  /** Participant-triggered retry after fixing their card — mirrors retryCharge(). */
  async retryHold(userId: string, contributionId: string) {
    const contribution = await prisma.campaignContribution.findUnique({ where: { id: contributionId }, include: { participant: true, paymentAuthorisation: true } });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    if (!contribution.paymentAuthorisation || contribution.paymentAuthorisation.holdStatus !== "HOLD_DECLINED") {
      throw new AppError("This pledge is not in a retryable state", 409);
    }
    return this.createHold(contribution.paymentAuthorisation.id);
  },

  async applyHoldIntentResult(authorisation: AuthorisationRecord, intent: Stripe.PaymentIntent) {
    if (intent.status === "requires_capture") {
      return this.markHoldSucceeded(authorisation, intent);
    }
    if (intent.status === "requires_action") {
      await prisma.communityBuyPaymentAuthorisation.update({
        where: { id: authorisation.id },
        data: { holdStatus: "REQUIRES_ACTION", paymentIntentId: intent.id, authenticationStatus: intent.status },
      });
      const contribution = await prisma.campaignContribution.findUniqueOrThrow({ where: { id: authorisation.contributionId }, include: { participant: true } });
      await notifyParticipant(contribution.participant.userId, "hold_requires_action", "Confirm your card", "Your bank needs one more security check to place this hold.", authorisation.campaignId);
      return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisation.id } });
    }
    if (intent.status === "processing") {
      await prisma.communityBuyPaymentAuthorisation.update({ where: { id: authorisation.id }, data: { paymentIntentId: intent.id } });
      return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisation.id } });
    }
    return this.markHoldDeclined(authorisation, `Unexpected status: ${intent.status}`, intent.status, intent.id);
  },

  async markHoldSucceeded(authorisation: AuthorisationRecord, intent: Stripe.PaymentIntent) {
    // See this file's HOLD_EXPIRY_FALLBACK_WARNING_MS comment — Stripe's
    // PaymentIntent object has no verified, reliable per-hold capture-by
    // timestamp field (M2 plan §J item 3), so captureBefore stays null
    // here rather than guessed. hold_expiry_monitor() falls back to the
    // explicitly-flagged default buffer only when this is null.
    const claim = await prisma.communityBuyPaymentAuthorisation.updateMany({
      where: { id: authorisation.id, holdStatus: { in: ["HOLD_PENDING", "REQUIRES_ACTION"] } },
      data: {
        holdStatus: "HOLD_SUCCEEDED",
        paymentIntentId: intent.id,
        authorisedAmount: intent.amount_capturable && intent.amount_capturable > 0 ? intent.amount_capturable : authorisation.consentedChargeAmount,
        holdCreatedAt: new Date(),
      },
    });
    if (claim.count !== 1) return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisation.id } });
    const contribution = await prisma.campaignContribution.findUniqueOrThrow({ where: { id: authorisation.contributionId }, include: { participant: true } });
    await notifyParticipant(contribution.participant.userId, "hold_succeeded", "Card temporarily authorised", "Your bank has temporarily authorised this amount. You have not been finally charged.", authorisation.campaignId);
    return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisation.id } });
  },

  async markHoldDeclined(authorisation: AuthorisationRecord, _message: string, providerErrorCode?: string, paymentIntentId?: string) {
    await prisma.communityBuyPaymentAuthorisation.update({
      where: { id: authorisation.id },
      data: {
        holdStatus: "HOLD_DECLINED",
        providerErrorCode: providerErrorCode ?? null,
        paymentIntentId: paymentIntentId ?? authorisation.paymentIntentId,
        holdRecoveryDeadline: new Date(Date.now() + HOLD_RECOVERY_WINDOW_MS),
      },
    });
    const contribution = await prisma.campaignContribution.findUniqueOrThrow({ where: { id: authorisation.contributionId }, include: { participant: true } });
    await notifyParticipant(contribution.participant.userId, "hold_declined", "We could not authorise your card", "Update your payment method to keep your place in this campaign.", authorisation.campaignId);
    return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisation.id } });
  },

  /** Cancels an uncaptured hold — spec §11.5: "Never call it a refund." Used for participant-driven release, organiser cancellation, and timeout sweeps alike. */
  async cancelHold(authorisationId: string, _reasonCode: string) {
    const authorisation = await prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
    if (authorisation.holdStatus === "HOLD_RELEASED") return authorisation;
    if (!["HOLD_PENDING", "REQUIRES_ACTION", "HOLD_SUCCEEDED", "HOLD_DECLINED"].includes(authorisation.holdStatus)) {
      throw new AppError("This hold cannot be released from its current state", 409);
    }
    const claim = await prisma.communityBuyPaymentAuthorisation.updateMany({
      where: { id: authorisationId, holdStatus: { in: ["HOLD_PENDING", "REQUIRES_ACTION", "HOLD_SUCCEEDED", "HOLD_DECLINED"] } },
      data: { holdStatus: "HOLD_RELEASED" },
    });
    if (claim.count !== 1) return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });

    if (authorisation.paymentIntentId) {
      try {
        await stripe.paymentIntents.cancel(authorisation.paymentIntentId, undefined, { stripeAccount: authorisation.supplierConnectedAccountId });
      } catch (error) {
        logger.warn("Stripe cancel failed for an already-released Community Buy hold (may already be cancelled/captured provider-side)", { authorisationId, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }
    await prisma.campaignContribution.updateMany({ where: { id: authorisation.contributionId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });
    const contribution = await prisma.campaignContribution.findUniqueOrThrow({ where: { id: authorisation.contributionId }, include: { participant: true } });
    await notifyParticipant(contribution.participant.userId, "hold_released", "You were not charged", "This campaign did not charge you. Your bank may briefly show a pending amount.", authorisation.campaignId);
    return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
  },

  async releaseAllHoldsForCampaign(campaignId: string, reasonCode: string): Promise<void> {
    const openHolds = await prisma.communityBuyPaymentAuthorisation.findMany({
      where: { campaignId, holdStatus: { in: ["HOLD_PENDING", "REQUIRES_ACTION", "HOLD_SUCCEEDED", "HOLD_DECLINED"] } },
    });
    for (const hold of openHolds) {
      await this.cancelHold(hold.id, reasonCode).catch((error) => {
        logger.error("Failed to release a Community Buy hold during campaign cancellation", { authorisationId: hold.id, campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
      });
    }
    // Contributions that never even reached a hold (e.g. SetupIntent never confirmed before deadline).
    await prisma.campaignContribution.updateMany({ where: { campaignId, status: "PLEDGED" }, data: { status: "CANCELLED" } });
  },

  // ─── Decision (spec §11.3 step 7-8, AT-11/12/13) ────────────────────────

  /** decision_deadline job — evaluates every HOLD_WINDOW campaign whose decisionDeadline has passed. */
  async evaluateAuthorisationDecisions(): Promise<{ evaluated: number; proceeded: number; decisionRequired: number }> {
    const due = await prisma.communityCampaign.findMany({
      where: { status: "HOLD_WINDOW", paymentMode: "AUTHORISE_THEN_CAPTURE", decisionDeadline: { lte: new Date() } },
    });
    let proceeded = 0;
    let decisionRequired = 0;
    for (const campaign of due) {
      const authorisedQuantity = await this.getAuthorisedQuantity(campaign.id);
      const minimum = campaign.minimumShares ?? 0;
      if (authorisedQuantity >= minimum) {
        const claim = await prisma.communityCampaign.updateMany({ where: { id: campaign.id, status: "HOLD_WINDOW" }, data: { status: "PAYMENT_CAPTURE" } });
        if (claim.count !== 1) continue;
        proceeded++;
        await this.notifyDecisionOutcome(campaign.id, "proceeding");
        await this.captureWorker(campaign.id);
      } else {
        const claim = await prisma.communityCampaign.updateMany({ where: { id: campaign.id, status: "HOLD_WINDOW" }, data: { status: "DECISION_REQUIRED", decisionRequiredAt: new Date() } });
        if (claim.count !== 1) continue;
        decisionRequired++;
        await this.notifyDecisionOutcome(campaign.id, "decision_required");
      }
    }
    return { evaluated: due.length, proceeded, decisionRequired };
  },

  async getAuthorisedQuantity(campaignId: string): Promise<number> {
    const rows = await prisma.campaignContribution.findMany({
      where: { campaignId, paymentAuthorisation: { holdStatus: "HOLD_SUCCEEDED" } },
      select: { quantity: true },
    });
    return rows.reduce((sum, r) => sum + r.quantity, 0);
  },

  async notifyDecisionOutcome(campaignId: string, outcome: "proceeding" | "decision_required") {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) return;
    if (outcome === "proceeding") {
      await notifyParticipant(campaign.organiser.userId, "authorisation_proceeding", "Your campaign is proceeding", `${campaign.title} reached its minimum authorised quantity — capturing payment now.`, campaignId);
    } else {
      await notifyParticipant(campaign.organiser.userId, "decision_required", "Decision required", `${campaign.title} is below its minimum authorised quantity. You have 24 hours to proceed or cancel.`, campaignId);
    }
  },

  /** POST /community-buys/:id/decision — organiser proceed/cancel below minimum. */
  async decide(userId: string, campaignId: string, action: "proceed" | "cancel") {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !organiser || campaign.organiserId !== organiser.id) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "DECISION_REQUIRED") throw new AppError("This campaign is not awaiting a decision", 409);

    if (action === "cancel") {
      const claim = await prisma.communityCampaign.updateMany({ where: { id: campaignId, status: "DECISION_REQUIRED" }, data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() } });
      if (claim.count !== 1) throw new AppError("This campaign is no longer awaiting a decision", 409);
      await this.releaseAllHoldsForCampaign(campaignId, "organiser_cancelled");
      await recordAudit({ actorId: userId, action: "community_campaign.decision_cancel", entityType: "CommunityCampaign", entityId: campaignId });
      return prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    }

    if (campaign.fulfilmentOwner === "SUPPLIER") {
      const reconfirmationDeadline = await this.computeReconfirmationDeadline(campaign.id);
      const authorisedQuantity = await this.getAuthorisedQuantity(campaignId);
      const claim = await prisma.communityCampaign.updateMany({
        where: { id: campaignId, status: "DECISION_REQUIRED" },
        data: { status: "AWAITING_SUPPLIER_RECONFIRMATION", reconfirmationRequestedAt: new Date(), reconfirmationDeadline, reconfirmationQuantity: authorisedQuantity },
      });
      if (claim.count !== 1) throw new AppError("This campaign is no longer awaiting a decision", 409);
      await this.notifySupplierReconfirmationRequested(campaignId, authorisedQuantity);
    } else {
      const claim = await prisma.communityCampaign.updateMany({ where: { id: campaignId, status: "DECISION_REQUIRED" }, data: { status: "PAYMENT_CAPTURE" } });
      if (claim.count !== 1) throw new AppError("This campaign is no longer awaiting a decision", 409);
      await this.captureWorker(campaignId);
    }
    await recordAudit({ actorId: userId, action: "community_campaign.decision_proceed", entityType: "CommunityCampaign", entityId: campaignId });
    return prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  },

  /** supplier_reconfirmation_timeout companion — decision_deadline's own 24h timeout (AT-13). */
  async evaluateDecisionTimeouts(): Promise<{ cancelled: number }> {
    const cutoff = new Date(Date.now() - DECISION_WINDOW_MS);
    const expired = await prisma.communityCampaign.findMany({ where: { status: "DECISION_REQUIRED", decisionRequiredAt: { lte: cutoff } } });
    let cancelled = 0;
    for (const campaign of expired) {
      const claim = await prisma.communityCampaign.updateMany({ where: { id: campaign.id, status: "DECISION_REQUIRED" }, data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() } });
      if (claim.count !== 1) continue;
      await this.releaseAllHoldsForCampaign(campaign.id, "decision_timeout");
      cancelled++;
    }
    return { cancelled };
  },

  // ─── Supplier reconfirmation (spec §10.5, AT-14/15/16/17) ───────────────

  /** spec 10.5 formula: earlier of the configured max response period and (earliest active capture_before − safety buffer). captureBefore is frequently null (see §J item 3), so this only tightens the deadline when a real value happens to exist. */
  async computeReconfirmationDeadline(campaignId: string): Promise<Date> {
    const configured = new Date(Date.now() + RECONFIRMATION_MAX_MS);
    const holds = await prisma.communityBuyPaymentAuthorisation.findMany({
      where: { campaignId, holdStatus: "HOLD_SUCCEEDED", captureBefore: { not: null } },
      select: { captureBefore: true },
      orderBy: { captureBefore: "asc" },
      take: 1,
    });
    const earliestCaptureBefore = holds[0]?.captureBefore;
    if (!earliestCaptureBefore) return configured;
    const bufferedFromCapture = new Date(earliestCaptureBefore.getTime() - RECONFIRMATION_SAFETY_BUFFER_MS);
    return bufferedFromCapture < configured ? bufferedFromCapture : configured;
  },

  async notifySupplierReconfirmationRequested(campaignId: string, reducedQuantity: number) {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: { supplier: { include: { vendor: true } }, supplierAccount: true },
    });
    if (!campaign) return;
    const recipientUserId = campaign.supplierAccount?.userId ?? campaign.supplier?.vendor.userId;
    if (!recipientUserId) return;
    await notifyParticipant(recipientUserId, "supplier_reconfirmation_requested", "Confirm reduced quantity", `${campaign.title} is below its original minimum — ${reducedQuantity} units authorised. Confirm you can still fulfil this reduced quantity.`, campaignId);
  },

  async applyReconfirmation(campaign: { id: string; title: string }, action: "confirm" | "decline", reason?: string) {
    if (action === "decline") {
      const claim = await prisma.communityCampaign.updateMany({
        where: { id: campaign.id, status: "AWAITING_SUPPLIER_RECONFIRMATION" },
        data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date(), supplierDeclineReason: reason?.trim() || null },
      });
      if (claim.count !== 1) throw new AppError("This campaign is no longer awaiting reconfirmation", 409);
      await this.releaseAllHoldsForCampaign(campaign.id, "supplier_declined_reduced_quantity");
      return prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    }
    const claim = await prisma.communityCampaign.updateMany({ where: { id: campaign.id, status: "AWAITING_SUPPLIER_RECONFIRMATION" }, data: { status: "PAYMENT_CAPTURE" } });
    if (claim.count !== 1) throw new AppError("This campaign is no longer awaiting reconfirmation", 409);
    await this.captureWorker(campaign.id);
    return prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
  },

  /** Legacy Vendor-backed supplier path — mirrors confirmSupplierCommitment()'s dual-function pattern. */
  async reconfirmForVendor(vendorId: string, campaignId: string, action: "confirm" | "decline", reason?: string) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !supplier || campaign.supplierId !== supplier.id) throw new AppError("Campaign not found", 404);
    return this.applyReconfirmation(campaign, action, reason);
  },

  /** Workstream 3 SupplierAccount path — mirrors confirmSupplierCommitmentForAccount()'s dual-function pattern. */
  async reconfirmForAccount(userId: string, campaignId: string, action: "confirm" | "decline", reason?: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !account || campaign.supplierAccountId !== account.id) throw new AppError("Campaign not found", 404);
    return this.applyReconfirmation(campaign, action, reason);
  },

  async evaluateReconfirmationTimeouts(): Promise<{ cancelled: number }> {
    const expired = await prisma.communityCampaign.findMany({ where: { status: "AWAITING_SUPPLIER_RECONFIRMATION", reconfirmationDeadline: { lte: new Date() } } });
    let cancelled = 0;
    for (const campaign of expired) {
      const claim = await prisma.communityCampaign.updateMany({ where: { id: campaign.id, status: "AWAITING_SUPPLIER_RECONFIRMATION" }, data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() } });
      if (claim.count !== 1) continue;
      await this.releaseAllHoldsForCampaign(campaign.id, "supplier_reconfirmation_timeout");
      cancelled++;
    }
    return { cancelled };
  },

  // ─── Capture (spec §11.4, AT-19/20/21/22/23/24) ─────────────────────────

  /** capture_worker job — captures every HOLD_SUCCEEDED authorisation for a PAYMENT_CAPTURE campaign, independently (one failure never affects another — same client requirement as chargeAllPledgesForCampaign() in the old mode). */
  async captureWorker(campaignId: string): Promise<{ total: number; captured: number; failed: number }> {
    const authorisations = await prisma.communityBuyPaymentAuthorisation.findMany({
      where: { campaignId, holdStatus: "HOLD_SUCCEEDED", captureStatus: "NOT_CAPTURED" },
    });
    let captured = 0;
    let failed = 0;
    for (const authorisation of authorisations) {
      try {
        const result = await this.captureHold(authorisation.id);
        if (result.captureStatus === "CAPTURED") captured++;
        else failed++;
      } catch (error) {
        failed++;
        logger.error("Community Buy capture attempt threw unexpectedly", { authorisationId: authorisation.id, campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }
    // Only successful captures are eligible; a capture that never resolves
    // to CAPTURED simply stays outside fulfilment (AT-20) — the campaign
    // still moves out of PAYMENT_CAPTURE once every hold has been
    // attempted, since per-contribution failures don't block others.
    await prisma.communityCampaign.updateMany({ where: { id: campaignId, status: "PAYMENT_CAPTURE" }, data: { status: "FULFILLING" } });
    await recordAudit({ actorId: SYSTEM_CRON_ACTOR, action: "community_campaign.capture_holds", entityType: "CommunityCampaign", entityId: campaignId, metadata: { total: authorisations.length, captured, failed } });
    return { total: authorisations.length, captured, failed };
  },

  async captureHold(authorisationId: string) {
    const authorisation = await prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
    if (authorisation.captureStatus === "CAPTURED") return authorisation; // idempotent
    if (authorisation.holdStatus !== "HOLD_SUCCEEDED" || authorisation.captureStatus !== "NOT_CAPTURED") {
      throw new AppError("This hold is not ready to be captured", 409);
    }

    const campaign = await prisma.communityCampaign.findUniqueOrThrow({ where: { id: authorisation.campaignId } });
    if (!campaign.country) throw new AppError("Campaign is missing its market configuration", 409);
    const config = await marketConfigurationService.get(campaign.country);
    if (config?.communityBuyFeeBps == null) {
      throw new AppError("This market has no configured Community Buy processing fee", 409, undefined, "FEE_NOT_CONFIGURED");
    }
    const grossAmount = authorisation.authorisedAmount ?? authorisation.consentedChargeAmount;
    const applicationFeeAmount = calculatePlatformFee(grossAmount, config.communityBuyFeeBps);

    const claim = await prisma.communityBuyPaymentAuthorisation.updateMany({ where: { id: authorisationId, captureStatus: "NOT_CAPTURED" }, data: { captureStatus: "CAPTURE_PENDING" } });
    if (claim.count !== 1) return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });

    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.capture(
        authorisation.paymentIntentId!,
        { application_fee_amount: applicationFeeAmount },
        { stripeAccount: authorisation.supplierConnectedAccountId, idempotencyKey: `capture:${authorisationId}` },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.communityBuyPaymentAuthorisation.update({ where: { id: authorisationId }, data: { captureStatus: "CAPTURE_FAILED", providerErrorCode: message } });
      const contribution = await prisma.campaignContribution.findUniqueOrThrow({ where: { id: authorisation.contributionId }, include: { participant: true } });
      await notifyParticipant(contribution.participant.userId, "capture_failed", "Payment could not be completed", "We could not complete your Community Buy payment. Contact support to resolve this.", authorisation.campaignId);
      return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
    }

    if (intent.status !== "succeeded") {
      await prisma.communityBuyPaymentAuthorisation.update({ where: { id: authorisationId }, data: { captureStatus: "CAPTURE_FAILED", providerErrorCode: intent.status } });
      return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisationId } });
    }
    return this.markCaptured(authorisation, intent, applicationFeeAmount, grossAmount);
  },

  /**
   * Ledger note: under Direct Charges, the supplier's net share never
   * touches an Eki-owned account — it lands directly in the supplier's OWN
   * connected-account Stripe balance via application_fee_amount. Eki only
   * ever sees the fee. SUPPLIER_CONNECTED_BALANCE (debit) / SUPPLIER_PAYABLE
   * (credit) is an INFORMATIONAL pair recording "money the supplier now
   * has, that Eki has a payable-tracking obligation for" — not a claim that
   * Eki custodies it (contrast with the old mode's COMMUNITY_BUY_ESCROW,
   * which is real platform-held cash). See campaign-payout.service.ts's
   * doc comment for what "payout release" can and cannot mean here.
   */
  async markCaptured(authorisation: AuthorisationRecord, intent: Stripe.PaymentIntent, applicationFeeAmount: number, grossAmount: number) {
    const claim = await prisma.communityBuyPaymentAuthorisation.updateMany({ where: { id: authorisation.id, captureStatus: "CAPTURE_PENDING" }, data: { captureStatus: "CAPTURED" } });
    if (claim.count !== 1) return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisation.id } });

    await prisma.campaignContribution.update({ where: { id: authorisation.contributionId }, data: { status: "PAID", stripePaymentIntentId: intent.id } });

    const netAmount = grossAmount - applicationFeeAmount;
    const campaign = await prisma.communityCampaign.findUniqueOrThrow({ where: { id: authorisation.campaignId } });
    const supplierLedgerOwnerId = await resolveCampaignSupplierLedgerOwnerId(campaign);

    await prisma.$transaction(async (tx) => {
      await ledgerService.postEntriesSafely(tx, {
        currency: authorisation.consentCurrency,
        businessRefType: "CommunityBuyPaymentAuthorisation",
        businessRefId: authorisation.id,
        providerRef: intent.id,
        description: `Community Buy hold captured (Direct Charge) for campaign ${authorisation.campaignId}`,
        legs: [
          { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: applicationFeeAmount },
          { accountType: LedgerAccountType.PLATFORM_FEE_REVENUE, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: applicationFeeAmount },
        ],
      });
      if (netAmount > 0 && supplierLedgerOwnerId) {
        await ledgerService.postEntriesSafely(tx, {
          currency: authorisation.consentCurrency,
          businessRefType: "CommunityBuyPaymentAuthorisation",
          businessRefId: authorisation.id,
          providerRef: intent.id,
          description: `Supplier's net share landed directly in their connected account (Direct Charge) — campaign ${authorisation.campaignId}`,
          legs: [
            { accountType: LedgerAccountType.SUPPLIER_CONNECTED_BALANCE, ownerType: LedgerOwnerType.SUPPLIER, ownerId: supplierLedgerOwnerId, direction: LedgerDirection.DEBIT, amount: netAmount },
            { accountType: LedgerAccountType.SUPPLIER_PAYABLE, ownerType: LedgerOwnerType.SUPPLIER, ownerId: supplierLedgerOwnerId, direction: LedgerDirection.CREDIT, amount: netAmount },
          ],
        });
      }
    });

    await this.onCaptureSucceeded(campaign, netAmount, applicationFeeAmount, grossAmount, authorisation.consentCurrency);

    const contribution = await prisma.campaignContribution.findUniqueOrThrow({ where: { id: authorisation.contributionId }, include: { participant: true } });
    await notifyParticipant(contribution.participant.userId, "capture_succeeded", "Payment complete", "Your Community Buy payment has been completed.", authorisation.campaignId);
    return prisma.communityBuyPaymentAuthorisation.findUniqueOrThrow({ where: { id: authorisation.id } });
  },

  /**
   * Fulfilment boundary (M2 plan §G): fulfilment-ready quantity is a live
   * SUM(quantity WHERE captureStatus=CAPTURED), never a stored/cached
   * count — computed the same "always recompute live" way totalPaid
   * already is in the old mode's releaseSupplierPayment(). This function
   * only creates/updates the CampaignFulfilment + CommunityBuyPayout rows
   * — it never creates them ahead of a real, successful capture the way
   * the old mode's createSupplierOrder() does at success-determination
   * time (a gap flagged in the prior compliance audit; this mode does not
   * repeat it).
   */
  async onCaptureSucceeded(campaign: { id: string; fulfilmentOwner: string; supplierAccountId: string | null; supplierId: string | null }, netAmount: number, feeAmount: number, grossAmount: number, currency: string): Promise<void> {
    await prisma.campaignFulfilment.upsert({ where: { campaignId: campaign.id }, update: {}, create: { campaignId: campaign.id } });

    if (campaign.fulfilmentOwner !== "SUPPLIER") return; // SELF-fulfilment: no payout row — same as the old mode's createSupplierOrder() short-circuit.
    const connectedAccountId = await resolveCampaignConnectedAccountId(campaign as { fulfilmentOwner: string; supplierAccountId: string | null; supplierId: string | null });
    const supplierLedgerOwnerId = await resolveCampaignSupplierLedgerOwnerId(campaign);
    if (!connectedAccountId || !supplierLedgerOwnerId) return;

    const existing = await prisma.communityBuyPayout.findUnique({ where: { campaignId: campaign.id } });
    if (existing) {
      await prisma.communityBuyPayout.update({
        where: { campaignId: campaign.id },
        data: {
          capturedGrossAmount: { increment: grossAmount },
          ekiFeeAmount: { increment: feeAmount },
          supplierPayableAmount: { increment: netAmount },
          netPayoutAmount: { increment: netAmount },
        },
      });
    } else {
      await prisma.communityBuyPayout.create({
        data: {
          campaignId: campaign.id,
          supplierId: supplierLedgerOwnerId,
          supplierConnectedAccountId: connectedAccountId,
          currency,
          capturedGrossAmount: grossAmount,
          ekiFeeAmount: feeAmount,
          supplierPayableAmount: netAmount,
          netPayoutAmount: netAmount,
          status: "HELD",
          holdReasonCodes: ["awaiting_fulfilment_confirmation"],
        },
      });
    }
  },

  // ─── Webhook resolution (spec §17.1) ────────────────────────────────────

  /** Called from stripe.service.ts for every payment_intent.* event whose metadata.kind === "community_buy_hold". Applies only a valid forward transition — tolerant of out-of-order delivery (AT-23), never double-applies (AT-22). */
  async resolveHoldWebhook(authorisationId: string, eventType: string, paymentIntent: Stripe.PaymentIntent): Promise<{ handled: boolean }> {
    const authorisation = await prisma.communityBuyPaymentAuthorisation.findUnique({ where: { id: authorisationId } });
    if (!authorisation) return { handled: false };

    if (eventType === "payment_intent.amount_capturable_updated") {
      if (authorisation.holdStatus === "HOLD_SUCCEEDED") return { handled: true }; // already applied synchronously — normal, not an error
      await this.markHoldSucceeded(authorisation, paymentIntent);
      return { handled: true };
    }
    if (eventType === "payment_intent.payment_failed") {
      if (authorisation.holdStatus !== "HOLD_PENDING" && authorisation.holdStatus !== "REQUIRES_ACTION") return { handled: true };
      await this.markHoldDeclined(authorisation, "Card declined", paymentIntent.last_payment_error?.code, paymentIntent.id);
      return { handled: true };
    }
    if (eventType === "payment_intent.canceled") {
      // An Eki-initiated cancel already sets HOLD_RELEASED synchronously in
      // cancelHold() — this branch only matters for an unexpected,
      // provider-initiated cancellation (e.g. issuer-side auto-expiry).
      if (authorisation.holdStatus === "HOLD_RELEASED") return { handled: true };
      await prisma.communityBuyPaymentAuthorisation.update({ where: { id: authorisationId }, data: { holdStatus: "HOLD_RELEASED" } });
      await prisma.campaignContribution.updateMany({ where: { id: authorisation.contributionId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });
      return { handled: true };
    }
    if (eventType === "payment_intent.succeeded") {
      if (authorisation.captureStatus === "CAPTURED") return { handled: true };
      const campaign = await prisma.communityCampaign.findUniqueOrThrow({ where: { id: authorisation.campaignId } });
      const config = campaign.country ? await marketConfigurationService.get(campaign.country) : null;
      const grossAmount = authorisation.authorisedAmount ?? authorisation.consentedChargeAmount;
      const applicationFeeAmount = calculatePlatformFee(grossAmount, config?.communityBuyFeeBps ?? 0);
      await this.markCaptured(authorisation, paymentIntent, applicationFeeAmount, grossAmount);
      return { handled: true };
    }
    return { handled: false };
  },

  // ─── Scheduled jobs (spec §17.2) ─────────────────────────────────────────

  /** hold_expiry_monitor — P0 warning based on the real captureBefore where we have one; see this file's HOLD_EXPIRY_FALLBACK_WARNING_MS comment for the explicitly-flagged fallback when we don't. */
  async holdExpiryMonitor(): Promise<{ flagged: number }> {
    const warningCutoff = new Date(Date.now() + HOLD_EXPIRY_WARNING_BUFFER_MS);
    const withRealDeadline = await prisma.communityBuyPaymentAuthorisation.findMany({
      where: { holdStatus: "HOLD_SUCCEEDED", captureBefore: { lte: warningCutoff, not: null } },
    });
    const fallbackCutoff = new Date(Date.now() - HOLD_EXPIRY_FALLBACK_WARNING_MS);
    const withoutRealDeadline = await prisma.communityBuyPaymentAuthorisation.findMany({
      where: { holdStatus: "HOLD_SUCCEEDED", captureBefore: null, holdCreatedAt: { lte: fallbackCutoff } },
    });
    const flagged = [...withRealDeadline, ...withoutRealDeadline];
    for (const hold of flagged) {
      await prisma.communityBuyPaymentAuthorisation.update({ where: { id: hold.id }, data: { holdStatus: "HOLD_EXPIRING", holdExpiryWarningAt: new Date() } });
      await recordAudit({
        actorId: SYSTEM_CRON_ACTOR,
        action: "community_buy_authorisation.hold_expiring_alert",
        entityType: "CommunityBuyPaymentAuthorisation",
        entityId: hold.id,
        metadata: { campaignId: hold.campaignId, captureBefore: hold.captureBefore, usedFallbackBuffer: hold.captureBefore == null },
      });
    }
    return { flagged: flagged.length };
  },

  /** payment_recovery_timeout — expires an unresolved declined/requires_action hold past its recovery deadline, releasing capacity. */
  async paymentRecoveryTimeout(): Promise<{ released: number }> {
    const expired = await prisma.communityBuyPaymentAuthorisation.findMany({
      where: { holdStatus: { in: ["HOLD_DECLINED", "REQUIRES_ACTION"] }, holdRecoveryDeadline: { lte: new Date() } },
    });
    let released = 0;
    for (const hold of expired) {
      await this.cancelHold(hold.id, "payment_recovery_timeout").catch(() => {});
      released++;
    }
    return { released };
  },

  // ─── Read model (spec §12, dashboard) ───────────────────────────────────

  async getAuthorisationSummary(campaignId: string) {
    const campaign = await prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    const contributions = await prisma.campaignContribution.findMany({
      where: { campaignId, status: { not: "INITIATED" } },
      include: { paymentAuthorisation: true },
    });
    let committedQuantity = 0;
    let authorisedQuantity = 0;
    let requiresActionQuantity = 0;
    let declinedQuantity = 0;
    let capturedQuantity = 0;
    for (const c of contributions) {
      if (c.status !== "CANCELLED") committedQuantity += c.quantity;
      const hold = c.paymentAuthorisation;
      if (!hold) continue;
      if (hold.holdStatus === "HOLD_SUCCEEDED") authorisedQuantity += c.quantity;
      if (hold.holdStatus === "REQUIRES_ACTION") requiresActionQuantity += c.quantity;
      if (hold.holdStatus === "HOLD_DECLINED") declinedQuantity += c.quantity;
      if (hold.captureStatus === "CAPTURED") capturedQuantity += c.quantity;
    }
    return {
      campaignId,
      paymentMode: campaign.paymentMode,
      status: campaign.status,
      minimumShares: campaign.minimumShares,
      maximumShares: campaign.maximumShares,
      committedQuantity,
      authorisedQuantity,
      requiresActionQuantity,
      declinedQuantity,
      capturedQuantity,
      // spec §12 fulfilment_ready_quantity — captured and operationally clear; M2's onCaptureSucceeded() doesn't track a separate exception state yet, so this equals capturedQuantity today.
      fulfilmentReadyQuantity: capturedQuantity,
      holdWindowStartsAt: campaign.holdWindowStartsAt,
      decisionDeadline: campaign.decisionDeadline,
      decisionRequiredAt: campaign.decisionRequiredAt,
      reconfirmationDeadline: campaign.reconfirmationDeadline,
      reconfirmationQuantity: campaign.reconfirmationQuantity,
    };
  },
};

export { resolveCampaignConnectedAccountId, resolveCampaignSupplierLedgerOwnerId };
