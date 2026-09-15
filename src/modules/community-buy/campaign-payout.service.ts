import type { CommunityBuyPayout } from "@prisma/client";
import type Stripe from "stripe";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

const SYSTEM_WEBHOOK_ACTOR = "system:stripe_webhook";

/**
 * M6 — server-side-recomputed payout eligibility. Called at BOTH markReady()
 * (HELD -> READY) and triggerManualPayout() (READY -> PENDING), never cached
 * between the two: a supplier can be suspended, or a dispute can open, in
 * the window between those two admin actions, and a stale eligibility
 * check from the first call must never authorize the second.
 */
async function assessPayoutEligibility(payout: CommunityBuyPayout): Promise<{ eligible: boolean; blockers: string[] }> {
  const blockers: string[] = [];

  const supplier = await prisma.supplierAccount.findUnique({ where: { id: payout.supplierId } });
  if (!supplier) {
    blockers.push("supplier_account_not_found");
  } else {
    if (supplier.supplierState === "SUSPENDED") blockers.push("supplier_suspended");
    if (supplier.supplierState === "RESTRICTED") blockers.push("supplier_restricted");
    if (supplier.supplierState === "CLOSED") blockers.push("supplier_closed");
    if (!supplier.chargesEnabled) blockers.push("stripe_charges_disabled");
    if (!supplier.payoutsEnabled) blockers.push("stripe_payouts_disabled");
  }

  const fulfilment = await prisma.campaignFulfilment.findUnique({ where: { campaignId: payout.campaignId } });
  if (!fulfilment || fulfilment.status !== "COMPLETED") blockers.push("fulfilment_not_completed");

  const exposureCount = await prisma.communityBuyPaymentAuthorisation.count({
    where: { campaignId: payout.campaignId, captureStatus: { in: ["DISPUTED", "REFUNDED"] } },
  });
  if (exposureCount > 0) blockers.push("dispute_or_refund_exposure");

  return { eligible: blockers.length === 0, blockers };
}

/**
 * M2 §H/§I — CommunityBuyPayout governance, WITHOUT falsely claiming fund
 * custody. Under Stripe Connect Direct Charges (campaign-authorisation.
 * service.ts), a supplier's net share lands in THEIR OWN connected
 * account's Stripe balance the instant a hold is captured — Eki never
 * custodies it (see CommunityBuyPayout's own schema doc comment, and
 * contrast with the old mode's CampaignSupplierPayment/releaseSupplierPayment(),
 * which really does move money via a platform->connected-account transfer).
 *
 * Whether this module's "release" step is EVER capable of real fund
 * control depends on an unresolved, explicitly-flagged external question
 * (M2 plan §J item 1 — spec §11.1 itself requires written provider
 * confirmation before production activation):
 *
 *   - If the connected account is configured with a MANUAL Stripe payout
 *     schedule, funds sit in the connected account's own balance until Eki
 *     calls stripe.payouts.create({...}, {stripeAccount}) — in which case
 *     this module's release genuinely holds/releases real money.
 *   - If the connected account is on Stripe's default AUTOMATIC schedule,
 *     Stripe pays the supplier's bank on its own timetable regardless of
 *     what this table says — `status` here is then purely advisory/
 *     reporting, not real custody.
 *
 * This has NOT been verified. COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED
 * therefore defaults false and gates the ONE function that would ever try
 * to move real money (triggerManualPayout) — it throws rather than
 * silently no-op'ing, so a caller can never mistake "did nothing" for
 * "succeeded." Every other function here (marking HELD/READY, computing
 * amounts, admin visibility) works regardless, since none of it depends on
 * the unresolved question.
 */
const PAYOUT_CUSTODY_CONFIRMED = process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED === "true";

export const campaignPayoutService = {
  async listForAdmin() {
    return prisma.communityBuyPayout.findMany({
      include: { campaign: { select: { id: true, title: true, confirmedShares: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async get(campaignId: string) {
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No Direct Charge payout record exists for this campaign", 404);
    return payout;
  },

  /** Supplier's own read-only view — never exposes other suppliers' records. Mirrors getMyPaymentForCampaign()'s dual-path shape. */
  async getMyPayout(supplierAccountIdOrVendorSupplierId: { supplierAccountId?: string; supplierId?: string }, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    const matches = supplierAccountIdOrVendorSupplierId.supplierAccountId
      ? campaign.supplierAccountId === supplierAccountIdOrVendorSupplierId.supplierAccountId
      : campaign.supplierId === supplierAccountIdOrVendorSupplierId.supplierId;
    if (!matches) throw new AppError("Campaign not found", 404);
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No payout record exists for this campaign yet", 404);
    return payout;
  },

  /** Admin marks fulfilment-confirmed / no open disputes -> HELD becomes READY. Never moves money by itself. Re-verifies eligibility server-side rather than trusting the admin's own judgement — see assessPayoutEligibility(). */
  async markReady(adminId: string, campaignId: string) {
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No payout record exists for this campaign", 404);
    if (payout.status !== "HELD") throw new AppError("Only a held payout can be marked ready", 409);
    const { eligible, blockers } = await assessPayoutEligibility(payout);
    if (!eligible) throw new AppError(`This payout is not eligible for release: ${blockers.join(", ")}`, 409, undefined, "PAYOUT_NOT_ELIGIBLE");
    const claim = await prisma.communityBuyPayout.updateMany({ where: { campaignId, status: "HELD" }, data: { status: "READY", releaseEligibleAt: new Date(), holdReasonCodes: [] } });
    if (claim.count !== 1) throw new AppError("This payout cannot be marked ready from its current state", 409);
    await recordAudit({ actorId: adminId, action: "community_buy_payout.marked_ready", entityType: "CommunityBuyPayout", entityId: payout.id });
    return prisma.communityBuyPayout.findUniqueOrThrow({ where: { campaignId } });
  },

  /** Read-only eligibility preview for admin UI — same computation triggerManualPayout()/markReady() enforce, exposed so the admin screen can explain a blocker before the admin even attempts the action. */
  async getEligibility(campaignId: string) {
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No payout record exists for this campaign", 404);
    return assessPayoutEligibility(payout);
  },

  async hold(adminId: string, campaignId: string, reasonCode: string) {
    if (!reasonCode?.trim()) throw new AppError("reasonCode is required", 400);
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No payout record exists for this campaign", 404);
    if (payout.status === "PAID") throw new AppError("This payout has already been paid", 409);
    const updated = await prisma.communityBuyPayout.update({
      where: { campaignId },
      data: { status: "HELD", holdReasonCodes: Array.from(new Set([...payout.holdReasonCodes, reasonCode])) },
    });
    await recordAudit({ actorId: adminId, action: "community_buy_payout.held", entityType: "CommunityBuyPayout", entityId: payout.id, metadata: { reasonCode } });
    return updated;
  },

  /**
   * The ONLY function in this module that would move real money — gated
   * behind PAYOUT_CUSTODY_CONFIRMED (see module doc comment above). Throws
   * a clear, machine-readable error rather than a silent no-op.
   *
   * Idempotency: the Stripe idempotency key is generated ONCE and persisted
   * to the row as part of the SAME guarded claim that moves READY/FAILED ->
   * PENDING, BEFORE the Stripe call is ever made. This means a crash,
   * timeout, or ambiguous network response between the claim and reading
   * Stripe's response can never orphan the key — every subsequent retry
   * (duplicate admin click, job retry, or an explicit retry of a FAILED
   * payout) reads the SAME persisted key back out and reuses it, so Stripe
   * itself guarantees at-most-one real payout no matter how many times this
   * function is called for the same campaign. Retrying is allowed from
   * READY (first attempt) or FAILED (an admin retrying a previously-failed
   * release) — never from any other state.
   */
  async triggerManualPayout(adminId: string, campaignId: string) {
    if (!PAYOUT_CUSTODY_CONFIRMED) {
      throw new AppError(
        "Manual Community Buy payouts are disabled: this connected account's Stripe payout-schedule configuration has not been confirmed (M2 plan §J item 1). Set COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED=true only after that confirmation.",
        503,
        undefined,
        "PAYOUT_CUSTODY_NOT_CONFIRMED",
      );
    }
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No payout record exists for this campaign", 404);
    if (payout.status !== "READY" && payout.status !== "FAILED") {
      throw new AppError("This payout is not ready for release", 409);
    }
    const { eligible, blockers } = await assessPayoutEligibility(payout);
    if (!eligible) throw new AppError(`This payout is not eligible for release: ${blockers.join(", ")}`, 409, undefined, "PAYOUT_NOT_ELIGIBLE");

    const idempotencyKey = payout.idempotencyKey ?? `community-buy-payout:${campaignId}:${payout.retryCount + 1}`;
    const claim = await prisma.communityBuyPayout.updateMany({
      where: { campaignId, status: payout.status },
      data: { status: "PENDING", requestedAt: new Date(), idempotencyKey },
    });
    if (claim.count !== 1) throw new AppError("This payout cannot be released from its current state", 409);

    try {
      const stripePayout = await stripe.payouts.create(
        { amount: payout.netPayoutAmount, currency: payout.currency },
        { stripeAccount: payout.supplierConnectedAccountId, idempotencyKey },
      );
      const updated = await prisma.communityBuyPayout.update({
        where: { campaignId },
        data: { status: "IN_TRANSIT", providerPayoutId: stripePayout.id, submittedAt: new Date(), retryCount: { increment: 1 } },
      });
      await recordAudit({ actorId: adminId, action: "community_buy_payout.released", entityType: "CommunityBuyPayout", entityId: payout.id, metadata: { providerPayoutId: stripePayout.id, idempotencyKey } });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.communityBuyPayout.update({ where: { campaignId }, data: { status: "FAILED", failureMessage: message, retryCount: { increment: 1 } } });
      throw new AppError(`Payout failed: ${message}`, 502);
    }
  },

  /**
   * M6 — provider-confirmed payout resolution. Nothing else in this module
   * (or anywhere else) ever transitions a payout to PAID: triggerManualPayout()
   * only ever reaches IN_TRANSIT, deliberately, because a successful
   * stripe.payouts.create() response only confirms Stripe ACCEPTED the
   * instruction, not that the supplier's bank actually received funds — the
   * spec's "never mark PAID without provider-confirmed evidence" rule
   * requires waiting for Stripe's own payout.paid webhook. Guarded on
   * status=IN_TRANSIT so a duplicate/out-of-order webhook delivery is a
   * safe no-op (count 0) rather than double-applying.
   */
  async resolvePayoutWebhook(providerPayoutId: string, eventType: string, stripePayout: Stripe.Payout): Promise<{ handled: boolean }> {
    if (eventType === "payout.paid") {
      const claim = await prisma.communityBuyPayout.updateMany({
        where: { providerPayoutId, status: "IN_TRANSIT" },
        data: {
          status: "PAID",
          paidAt: new Date(),
          providerBalanceTransactionId: typeof stripePayout.balance_transaction === "string" ? stripePayout.balance_transaction : (stripePayout.balance_transaction?.id ?? null),
        },
      });
      if (claim.count === 1) {
        const payout = await prisma.communityBuyPayout.findFirst({ where: { providerPayoutId } });
        if (payout) {
          await recordAudit({ actorId: SYSTEM_WEBHOOK_ACTOR, action: "community_buy_payout.paid_confirmed", entityType: "CommunityBuyPayout", entityId: payout.id, metadata: { providerPayoutId } });
        }
      }
      return { handled: claim.count === 1 };
    }

    if (eventType === "payout.failed" || eventType === "payout.canceled") {
      const nextStatus = eventType === "payout.canceled" ? "CANCELLED" : "FAILED";
      const claim = await prisma.communityBuyPayout.updateMany({
        where: { providerPayoutId, status: "IN_TRANSIT" },
        data: {
          status: nextStatus,
          failedAt: new Date(),
          failureCode: stripePayout.failure_code ?? null,
          failureMessage: stripePayout.failure_message ?? (eventType === "payout.canceled" ? "Payout canceled by provider" : null),
        },
      });
      if (claim.count === 1) {
        const payout = await prisma.communityBuyPayout.findFirst({ where: { providerPayoutId } });
        if (payout) {
          await recordAudit({ actorId: SYSTEM_WEBHOOK_ACTOR, action: "community_buy_payout.terminal_confirmed", entityType: "CommunityBuyPayout", entityId: payout.id, metadata: { providerPayoutId, eventType } });
        }
      }
      return { handled: claim.count === 1 };
    }

    return { handled: false };
  },

  /**
   * M6 reconciliation escalation path — called ONLY by
   * community-buy-reconciliation.service.ts when it finds a genuine
   * provider/local mismatch it must never silently auto-correct. A payout
   * already PAID is left untouched (nothing left to protect by escalating).
   */
  async escalateToManualReview(campaignId: string, reasonCode: string) {
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout || payout.status === "PAID") return payout;
    const updated = await prisma.communityBuyPayout.update({
      where: { campaignId },
      data: { status: "MANUAL_REVIEW", holdReasonCodes: Array.from(new Set([...payout.holdReasonCodes, reasonCode])) },
    });
    await recordAudit({ actorId: SYSTEM_WEBHOOK_ACTOR, action: "community_buy_payout.escalated_manual_review", entityType: "CommunityBuyPayout", entityId: payout.id, metadata: { reasonCode } });
    return updated;
  },

  /** Best-effort auto-hold on a dispute/refund detected against a captured hold — never throws (called from webhook handlers whose own contract is never-throws). No-op if no payout row exists yet or it's already PAID. */
  async holdForSystemReason(campaignId: string, reasonCode: string): Promise<void> {
    try {
      await this.hold(SYSTEM_WEBHOOK_ACTOR, campaignId, reasonCode);
    } catch {
      // No payout row yet (dispute/refund arrived before any capture created
      // one) or already PAID — both are normal, not errors worth surfacing.
    }
  },
};

export { PAYOUT_CUSTODY_CONFIRMED };
