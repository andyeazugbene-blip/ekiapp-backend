import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { calculatePlatformFee } from "../../shared/pricing";
import { marketConfigurationService } from "./market-configuration.service";
import { resolveCampaignSupplierLedgerOwnerId } from "./campaign-supplier-resolution.service";

const SYSTEM_WEBHOOK_ACTOR = "system:stripe_webhook";

/**
 * M7 (spec §13.3/§15.6/§26) — CommunityBuyOrganiserFee governance.
 *
 * This is an ACCOUNTING/ACCRUAL model, not a payout mechanism. Spec §1.3
 * explicitly excludes "cash organiser fees" from version one "unless a
 * provider-approved settlement route is confirmed," and §26 names
 * "Organiser reward: compliant settlement route... cash organiser fee" as
 * an unresolved external dependency. There is also no organiser-side
 * Stripe Connect account anywhere in this codebase to move real money to.
 *
 * Two settlement methods need no cash movement through Eki at all and are
 * therefore safe to record today, exactly as spec §1.3 allows: a
 * supplier-paid EXTERNAL_SUPPLIER_ARRANGEMENT, or a NON_CASH_REWARD. The
 * one method that WOULD move real cash — STRIPE_CONNECT_TRANSFER — is
 * gated behind COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED, defaults
 * false, and settleFee() throws rather than silently no-op'ing, mirroring
 * campaign-payout.service.ts's PAYOUT_CUSTODY_CONFIRMED gate exactly.
 */
const ORGANISER_FEE_SETTLEMENT_CONFIRMED = process.env.COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED === "true";

function computeNet(fee: { grossFeeAmount: number; refundDeductionAmount: number; disputeDeductionAmount: number }): number {
  return Math.max(0, fee.grossFeeAmount - fee.refundDeductionAmount - fee.disputeDeductionAmount);
}

export const organiserFeeService = {
  async listForAdmin() {
    return prisma.communityBuyOrganiserFee.findMany({
      include: { campaign: { select: { id: true, title: true, organiserId: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async get(campaignId: string) {
    const fee = await prisma.communityBuyOrganiserFee.findUnique({ where: { campaignId } });
    if (!fee) throw new AppError("No organiser fee record exists for this campaign", 404);
    return fee;
  },

  /** Organiser's own read-only view — never exposes another organiser's record. */
  async getMyFee(organiserId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.organiserId !== organiserId) throw new AppError("Campaign not found", 404);
    const fee = await prisma.communityBuyOrganiserFee.findUnique({ where: { campaignId } });
    if (!fee) throw new AppError("No organiser fee record exists for this campaign yet", 404);
    return fee;
  },

  /**
   * The ONLY function that creates/increments a CommunityBuyOrganiserFee —
   * called exactly once per captured contribution, from the single
   * capture-success point in each payment mode (campaign-contributions.
   * service.ts's markChargeSucceeded() and campaign-authorisation.
   * service.ts's markCaptured()), both of which are themselves already
   * guarded against double-invocation. OrganiserFeeAccrualEvent's unique
   * constraint on contributionId is a second, independent guarantee against
   * ever double-counting the same capture (master prompt invariant).
   *
   * Never throws — mirrors campaign-fulfilment.service.ts's
   * recordFulfilmentEvent() never-throws contract, since this is always
   * called as a side effect of a payment confirmation that must not be put
   * at risk by a bookkeeping failure.
   */
  async accrueForCapturedContribution(contributionId: string): Promise<void> {
    try {
      const contribution = await prisma.campaignContribution.findUnique({
        where: { id: contributionId },
        include: { campaign: true },
      });
      if (!contribution) return;
      // Self-dealing exclusion: an organiser's own rescue-window top-up is
      // not an acquisition of anyone, so it never accrues a reward for
      // acquiring itself.
      if (contribution.isOrganiserTopUp) return;
      // Self-supply exclusion (spec §13.3: "for third-party supply") — the
      // organiser already IS the supplier; no second reward is described.
      if (contribution.campaign.fulfilmentOwner !== "SUPPLIER") return;
      if (!contribution.campaign.country || !contribution.campaign.pricePerShareMinor) return;

      const market = await marketConfigurationService.get(contribution.campaign.country);
      if (!market?.organiserFeeBps) return; // No organiser-fee program configured for this market — never invent a default rate.

      await prisma.organiserFeeAccrualEvent.create({
        data: { campaignId: contribution.campaignId, contributionId, quantity: contribution.quantity, amount: contribution.amount },
      });

      const feePerCapturedOrder = calculatePlatformFee(contribution.campaign.pricePerShareMinor, market.organiserFeeBps);
      const supplierId = await resolveCampaignSupplierLedgerOwnerId(contribution.campaign);

      const existing = await prisma.communityBuyOrganiserFee.findUnique({ where: { campaignId: contribution.campaignId } });
      if (existing) {
        const grossFeeAmount = existing.grossFeeAmount + feePerCapturedOrder * contribution.quantity;
        await prisma.communityBuyOrganiserFee.update({
          where: { campaignId: contribution.campaignId },
          data: {
            capturedQuantity: { increment: contribution.quantity },
            grossFeeAmount,
            netFeeAmount: computeNet({ grossFeeAmount, refundDeductionAmount: existing.refundDeductionAmount, disputeDeductionAmount: existing.disputeDeductionAmount }),
          },
        });
      } else {
        const grossFeeAmount = feePerCapturedOrder * contribution.quantity;
        await prisma.communityBuyOrganiserFee.create({
          data: {
            campaignId: contribution.campaignId,
            organiserId: contribution.campaign.organiserId,
            supplierId,
            currency: contribution.currency,
            feePerCapturedOrder,
            capturedQuantity: contribution.quantity,
            grossFeeAmount,
            netFeeAmount: grossFeeAmount,
          },
        });
      }
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === "P2002") return; // Duplicate accrual attempt for the same capture — already recorded, safe no-op.
      logger.error("Community Buy organiser fee accrual failed", { contributionId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  },

  async hold(adminId: string, campaignId: string, reasonCode: string) {
    if (!reasonCode?.trim()) throw new AppError("reasonCode is required", 400);
    const fee = await prisma.communityBuyOrganiserFee.findUnique({ where: { campaignId } });
    if (!fee) throw new AppError("No organiser fee record exists for this campaign", 404);
    if (fee.status === "SETTLED") throw new AppError("This organiser fee has already been settled", 409);
    const updated = await prisma.communityBuyOrganiserFee.update({
      where: { campaignId },
      data: { status: "HELD", heldReasonCodes: Array.from(new Set([...fee.heldReasonCodes, reasonCode])) },
    });
    await recordAudit({ actorId: adminId, action: "community_buy_organiser_fee.held", entityType: "CommunityBuyOrganiserFee", entityId: fee.id, metadata: { reasonCode } });
    return updated;
  },

  /** Best-effort auto-hold on a dispute/refund detected against a captured hold underlying this campaign's fee — never throws (called from webhook handlers). No-op if no fee row exists yet or it's already SETTLED. */
  async holdForSystemReason(campaignId: string, reasonCode: string): Promise<void> {
    try {
      await this.hold(SYSTEM_WEBHOOK_ACTOR, campaignId, reasonCode);
    } catch {
      // No fee row yet, or already SETTLED — both normal, not errors.
    }
  },

  async release(adminId: string, campaignId: string) {
    const fee = await prisma.communityBuyOrganiserFee.findUnique({ where: { campaignId } });
    if (!fee) throw new AppError("No organiser fee record exists for this campaign", 404);
    if (fee.status !== "HELD") throw new AppError("Only a held organiser fee can be released", 409);
    const claim = await prisma.communityBuyOrganiserFee.updateMany({ where: { campaignId, status: "HELD" }, data: { status: "ACCRUED", heldReasonCodes: [] } });
    if (claim.count !== 1) throw new AppError("This organiser fee cannot be released from its current state", 409);
    await recordAudit({ actorId: adminId, action: "community_buy_organiser_fee.released", entityType: "CommunityBuyOrganiserFee", entityId: fee.id });
    return prisma.communityBuyOrganiserFee.findUniqueOrThrow({ where: { campaignId } });
  },

  /**
   * Records that this organiser reward was settled through an approved,
   * non-Eki-cash route (spec §1.3) — no Stripe call for these two methods,
   * since neither moves money through Eki. STRIPE_CONNECT_TRANSFER is the
   * only method that would ever move real cash and is refused unless
   * COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED=true (never set in
   * this environment — no organiser Stripe Connect onboarding exists).
   */
  async settleFee(adminId: string, campaignId: string, settlementMethod: "EXTERNAL_SUPPLIER_ARRANGEMENT" | "NON_CASH_REWARD" | "STRIPE_CONNECT_TRANSFER", providerReference?: string) {
    if (settlementMethod === "STRIPE_CONNECT_TRANSFER" && !ORGANISER_FEE_SETTLEMENT_CONFIRMED) {
      throw new AppError(
        "Cash organiser fee settlement is disabled: no provider-approved settlement route has been confirmed (spec §26). Set COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED=true only after that confirmation.",
        503,
        undefined,
        "ORGANISER_FEE_SETTLEMENT_ROUTE_NOT_CONFIRMED",
      );
    }
    const fee = await prisma.communityBuyOrganiserFee.findUnique({ where: { campaignId } });
    if (!fee) throw new AppError("No organiser fee record exists for this campaign", 404);
    if (fee.status !== "ACCRUED") throw new AppError("Only an accrued organiser fee can be settled", 409);
    if (fee.netFeeAmount <= 0) throw new AppError("Nothing has been accrued to settle for this campaign yet", 409);

    const claim = await prisma.communityBuyOrganiserFee.updateMany({ where: { campaignId, status: "ACCRUED" }, data: { status: "SETTLED", settlementMethod, providerReference: providerReference ?? null, settledAt: new Date() } });
    if (claim.count !== 1) throw new AppError("This organiser fee cannot be settled from its current state", 409);
    await recordAudit({ actorId: adminId, action: "community_buy_organiser_fee.settled", entityType: "CommunityBuyOrganiserFee", entityId: fee.id, metadata: { settlementMethod, providerReference } });
    return prisma.communityBuyOrganiserFee.findUniqueOrThrow({ where: { campaignId } });
  },
};

export { ORGANISER_FEE_SETTLEMENT_CONFIRMED };
