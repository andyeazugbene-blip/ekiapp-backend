import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

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

  /** Admin marks fulfilment-confirmed / no open disputes -> HELD becomes READY. Never moves money by itself. */
  async markReady(adminId: string, campaignId: string) {
    const payout = await prisma.communityBuyPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No payout record exists for this campaign", 404);
    if (payout.status !== "HELD") throw new AppError("Only a held payout can be marked ready", 409);
    const claim = await prisma.communityBuyPayout.updateMany({ where: { campaignId, status: "HELD" }, data: { status: "READY", releaseEligibleAt: new Date(), holdReasonCodes: [] } });
    if (claim.count !== 1) throw new AppError("This payout cannot be marked ready from its current state", 409);
    await recordAudit({ actorId: adminId, action: "community_buy_payout.marked_ready", entityType: "CommunityBuyPayout", entityId: payout.id });
    return prisma.communityBuyPayout.findUniqueOrThrow({ where: { campaignId } });
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
    if (payout.status !== "READY") throw new AppError("This payout is not ready for release", 409);

    const claim = await prisma.communityBuyPayout.updateMany({ where: { campaignId, status: "READY" }, data: { status: "PENDING", requestedAt: new Date() } });
    if (claim.count !== 1) throw new AppError("This payout cannot be released from its current state", 409);

    const idempotencyKey = payout.idempotencyKey ?? `community-buy-payout:${campaignId}:${payout.retryCount + 1}`;
    try {
      const stripePayout = await stripe.payouts.create(
        { amount: payout.netPayoutAmount, currency: payout.currency },
        { stripeAccount: payout.supplierConnectedAccountId, idempotencyKey },
      );
      const updated = await prisma.communityBuyPayout.update({
        where: { campaignId },
        data: { status: "IN_TRANSIT", providerPayoutId: stripePayout.id, submittedAt: new Date(), idempotencyKey, retryCount: { increment: 1 } },
      });
      await recordAudit({ actorId: adminId, action: "community_buy_payout.released", entityType: "CommunityBuyPayout", entityId: payout.id, metadata: { providerPayoutId: stripePayout.id } });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.communityBuyPayout.update({ where: { campaignId }, data: { status: "FAILED", failureMessage: message, retryCount: { increment: 1 } } });
      throw new AppError(`Payout failed: ${message}`, 502);
    }
  },
};

export { PAYOUT_CUSTODY_CONFIRMED };
