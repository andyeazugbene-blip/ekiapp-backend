import type Stripe from "stripe";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { resolveStripeCurrency } from "../../shared/currency";
import { calculatePlatformFee } from "../../shared/pricing";
import { ledgerService } from "../ledger/ledger.service";
import { LedgerAccountType, LedgerDirection, LedgerOwnerType } from "@prisma/client";
import { marketConfigurationService } from "./market-configuration.service";
import { notificationsService } from "../notifications/notifications.service";
import { recordAudit } from "../../shared/utils/audit";

/**
 * Diaspora escrow reconciliation (final V1 settlement doc §N) — the
 * organiser's counterpart to campaign-contributions.service.ts's
 * releaseSupplierPayment(). The organiser is now the primary commercial
 * recipient of a successful Community Buy campaign's proceeds (net of Eki's
 * 10% platform commission), for BOTH self-fulfilled and supplier-fulfilled
 * campaigns — a capability that never existed before this change (a
 * self-fulfilled organiser previously had no payout mechanism at all).
 *
 * Doc §N item 5: "Stripe Connect funds segregation is the target settlement
 * architecture, subject to Stripe approving Eki for that feature. Until
 * approval is confirmed, keep affected live payment-release functionality
 * behind a feature flag." This is exactly that flag — mirrors
 * campaign-payout.service.ts's PAYOUT_CUSTODY_CONFIRMED gate exactly (same
 * shape, same "throws rather than silently no-ops" contract). Unlike
 * releaseSupplierPayment() (already live/ungated before this change), the
 * organiser Transfer call is brand new, so it starts gated rather than live.
 */
const ORGANISER_PAYOUT_ENABLED = process.env.COMMUNITY_BUY_ORGANISER_PAYOUT_ENABLED === "true";

export const organiserPayoutService = {
  async get(campaignId: string) {
    const payout = await prisma.communityBuyOrganiserPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No organiser payout record exists for this campaign", 404);
    return payout;
  },

  /** Organiser's own read-only view — never exposes another organiser's record. */
  async getMyPayout(organiserId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.organiserId !== organiserId) throw new AppError("Campaign not found", 404);
    const payout = await prisma.communityBuyOrganiserPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No organiser payout record exists for this campaign yet", 404);
    return payout;
  },

  async listForAdmin() {
    return prisma.communityBuyOrganiserPayout.findMany({
      include: { campaign: { select: { id: true, title: true, confirmedShares: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async holdOrganiserPayout(adminId: string, campaignId: string, reason: string) {
    const payout = await prisma.communityBuyOrganiserPayout.findUnique({ where: { campaignId } });
    if (!payout) throw new AppError("No organiser payout record exists for this campaign", 404);
    if (payout.status === "PAID") throw new AppError("This payout has already been paid", 409);
    // Phase 8 — guarded claim: releaseOrganiserPayment() can be concurrently
    // mid-transfer (status already claimed to PROCESSING) by the time this
    // read/write pair runs. An unconditional write would clobber that back
    // to ON_HOLD even though a real Stripe transfer is in flight or has
    // already landed.
    const claim = await prisma.communityBuyOrganiserPayout.updateMany({
      where: { campaignId, status: { in: ["NOT_RELEASED", "ON_HOLD"] } },
      data: { status: "ON_HOLD", holdReason: reason },
    });
    if (claim.count !== 1) throw new AppError("This payout cannot be held from its current state", 409);
    return prisma.communityBuyOrganiserPayout.findUniqueOrThrow({ where: { campaignId } });
  },

  /**
   * Recomputes the organiser's gross proceeds live from actual PAID
   * contributions and the campaign's supplier settlement (if any), then
   * releases the net (gross minus Eki's organiser commission) via Stripe
   * Connect Transfer — gated behind ORGANISER_PAYOUT_ENABLED. Mirrors
   * releaseSupplierPayment()'s exact structure: status guard, live
   * recompute, atomic PROCESSING claim, Transfer, ON_HOLD-on-failure,
   * ledger posting.
   */
  async releaseOrganiserPayment(adminId: string, campaignId: string) {
    const payout = await prisma.communityBuyOrganiserPayout.findUnique({
      where: { campaignId },
      include: { campaign: true, organiser: true },
    });
    if (!payout) throw new AppError("No organiser payout record exists for this campaign", 404);
    if (payout.status === "PAID") return payout;
    if (payout.status !== "NOT_RELEASED" && payout.status !== "ON_HOLD") {
      throw new AppError("This payout cannot be released from its current state", 409);
    }

    const paidAgg = await prisma.campaignContribution.aggregate({
      where: { campaignId, status: "PAID" },
      _sum: { amount: true, buyerServiceFeeAmount: true, deliveryFeeAmountMinor: true },
    });
    const totalCollected = paidAgg._sum.amount ?? 0;
    // Phase 6 (delivery + collection/tracking) — deliveryFeeAmountMinor was
    // correctly charged (chargedAmount already includes it — see
    // campaign-contributions.service.ts's markChargeSucceeded()) but never
    // recognized anywhere at settlement: releaseSupplierPayment() only ever
    // debits the product-amount-derived releaseBase from escrow, and this
    // function used to recognize buyerServiceFeeAmount alone. The delivery
    // fee is buyer-paid, courier-facing revenue that never belongs to the
    // supplier or organiser (there is no real courier to pay out to yet —
    // see community-buy-privacy.service.ts's own doc comment on why one
    // isn't invented), so it is recognized as platform revenue here
    // exactly like buyerServiceFeeAmount is, at the one release point every
    // successful campaign reaches regardless of fulfilment type. 0 for
    // every COLLECTION campaign.
    const totalBuyerFees = (paidAgg._sum.buyerServiceFeeAmount ?? 0) + (paidAgg._sum.deliveryFeeAmountMinor ?? 0);
    if (totalCollected <= 0) {
      throw new AppError("No contributions have been successfully charged for this campaign yet", 409, undefined, "NOTHING_COLLECTED_YET");
    }

    const supplierPayment = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId } });
    // Doc §N item 4 — self-supply and external-supplier-via-self keep 100%
    // of the retail proceeds (minus their own commission below); a
    // supplier-fulfilled campaign with an explicit wholesale figure gets
    // only the remainder after the supplier's wholesale amount; a LEGACY
    // supplier-fulfilled campaign with no wholesale figure already sent
    // 100% to the supplier via the unmodified original releaseSupplierPayment()
    // path, so there is genuinely nothing left for the organiser here.
    const organiserGross = !supplierPayment
      ? totalCollected
      : supplierPayment.wholesaleAmount != null
        ? Math.max(0, totalCollected - supplierPayment.wholesaleAmount)
        : 0;

    if (!payout.campaign.country) throw new AppError("Campaign is missing its market configuration", 409);
    const config = await marketConfigurationService.get(payout.campaign.country);
    if (!config) throw new AppError("This market has no configuration — set one before releasing organiser payments", 409, undefined, "FEE_NOT_CONFIGURED");

    const organiserCommission = organiserGross > 0 ? calculatePlatformFee(organiserGross, config.organiserCommissionBps) : 0;
    const organiserNet = Math.max(0, organiserGross - organiserCommission);

    // Nothing due to the organiser (legacy no-wholesale supplier campaign) —
    // settle this record administratively without attempting a $0 transfer.
    // Buyer-service-fee and delivery-fee revenue are still recognized here
    // since this is the one release point every successful campaign
    // reaches regardless of fulfilment type.
    if (organiserGross <= 0) {
      const claim = await prisma.communityBuyOrganiserPayout.updateMany({
        where: { campaignId, status: { in: ["NOT_RELEASED", "ON_HOLD"] } },
        data: { status: "PAID", amount: 0, commissionAmount: 0, netAmount: 0, releasedById: adminId, releasedAt: new Date(), holdReason: null },
      });
      if (claim.count !== 1) throw new AppError("This payout cannot be released from its current state", 409);
      if (totalBuyerFees > 0) {
        await ledgerService.postEntriesSafely(prisma, {
          currency: payout.currency,
          businessRefType: "CommunityBuyOrganiserPayout",
          businessRefId: payout.id,
          description: `Community Buy buyer service fee + delivery fee revenue for campaign ${campaignId} (no organiser proceeds — full amount settled to supplier)`,
          legs: [
            { accountType: LedgerAccountType.COMMUNITY_BUY_ESCROW, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: totalBuyerFees },
            { accountType: LedgerAccountType.PLATFORM_FEE_REVENUE, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: totalBuyerFees },
          ],
        }).catch((error) => {
          logger.error("Ledger posting failed for Community Buy buyer-fee-only settlement (non-fatal)", { campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
        });
      }
      return prisma.communityBuyOrganiserPayout.findUniqueOrThrow({ where: { campaignId } });
    }

    const payoutStripeAccountId = payout.organiser.providerConnectedAccountId;
    if (payout.payoutStripeAccountIdAtApproval && payoutStripeAccountId !== payout.payoutStripeAccountIdAtApproval) {
      throw new AppError("The organiser's payout account has changed since approval — reverification is required before release", 409, undefined, "PAYOUT_ACCOUNT_CHANGED");
    }
    if (!payoutStripeAccountId || !payout.organiser.payoutsEnabled || !payout.organiser.chargesEnabled) {
      throw new AppError("This organiser's payout account is not ready to receive transfers", 409, undefined, "PAYOUTS_NOT_ENABLED");
    }
    if (!ORGANISER_PAYOUT_ENABLED) {
      throw new AppError(
        "Organiser Community Buy payouts are disabled: Stripe Connect funds segregation for organisers has not been confirmed (final V1 settlement doc §N item 5). Set COMMUNITY_BUY_ORGANISER_PAYOUT_ENABLED=true only after that confirmation.",
        409,
        undefined,
        "ORGANISER_PAYOUT_NOT_CONFIRMED",
      );
    }

    const claim = await prisma.communityBuyOrganiserPayout.updateMany({
      where: { campaignId, status: { in: ["NOT_RELEASED", "ON_HOLD"] } },
      data: { status: "PROCESSING", amount: organiserGross, commissionAmount: organiserCommission, netAmount: organiserNet },
    });
    if (claim.count !== 1) throw new AppError("This payout cannot be released from its current state", 409);

    let transfer: Stripe.Transfer;
    try {
      transfer = await stripe.transfers.create(
        {
          amount: organiserNet,
          currency: resolveStripeCurrency(payout.currency),
          destination: payoutStripeAccountId,
          transfer_group: `community-buy-organiser:${campaignId}`,
          description: `Community Buy organiser settlement for campaign ${campaignId}`,
        },
        { idempotencyKey: `community-buy-organiser-transfer:${campaignId}` },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.communityBuyOrganiserPayout.update({ where: { campaignId }, data: { status: "ON_HOLD", holdReason: `Transfer failed: ${message}` } });
      throw new AppError(`Organiser transfer failed: ${message}`, 502);
    }

    const updated = await prisma.communityBuyOrganiserPayout.update({
      where: { campaignId },
      data: { status: "PAID", releasedById: adminId, releasedAt: new Date(), stripeTransferId: transfer.id, holdReason: null },
    });

    const legs = [
      { accountType: LedgerAccountType.COMMUNITY_BUY_ESCROW, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: organiserGross },
      { accountType: LedgerAccountType.ORGANISER_PAYABLE, ownerType: LedgerOwnerType.ORGANISER, ownerId: payout.organiserId, direction: LedgerDirection.CREDIT, amount: organiserNet },
      { accountType: LedgerAccountType.PLATFORM_FEE_REVENUE, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: organiserCommission },
    ];
    if (totalBuyerFees > 0) {
      legs.push(
        { accountType: LedgerAccountType.COMMUNITY_BUY_ESCROW, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: totalBuyerFees },
        { accountType: LedgerAccountType.PLATFORM_FEE_REVENUE, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: totalBuyerFees },
      );
    }

    await ledgerService.postEntriesSafely(prisma, {
      currency: payout.currency,
      businessRefType: "CommunityBuyOrganiserPayout",
      businessRefId: payout.id,
      providerRef: transfer.id,
      description: `Community Buy organiser settlement for campaign ${campaignId} — net of Eki organiser commission`,
      legs,
    }).catch((error) => {
      logger.error("Ledger posting failed for Community Buy organiser settlement (non-fatal — transfer already completed)", { campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
    });

    await recordAudit({
      actorId: adminId,
      action: "community_buy_organiser_payout.released",
      entityType: "CommunityBuyOrganiserPayout",
      entityId: payout.id,
      metadata: { campaignId, organiserGross, organiserCommission, organiserNet },
    });

    await notificationsService.enqueue({
      userId: payout.organiser.userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: "Payout released",
      body: "Your Community Buy campaign proceeds have been released to your Stripe account.",
      data: { type: "community_campaign_update", event: "organiser_payout_released", campaignId },
    }).catch(() => {});

    return updated;
  },
};

export { ORGANISER_PAYOUT_ENABLED };
