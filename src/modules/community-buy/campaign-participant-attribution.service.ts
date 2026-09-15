import type { AttributionSource, CampaignParticipant } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

const ATTRIBUTION_WINDOW_MONTHS = 12;

interface AttributionFields {
  acquisitionOrganiserId?: string;
  acquisitionCampaignId?: string;
  acquiredAt?: Date;
  organiserAttributionExpiresAt?: Date;
  attributionSource?: AttributionSource;
  repeatCampaignParentId?: string;
}

/**
 * spec §14.5/§15.2 — organiser acquisition attribution.
 *
 * - The joining user IS the campaign's own organiser: SELF. No acquisition
 *   credited (prevents an organiser from "acquiring" themselves).
 * - The user already has an unexpired acquisition from THIS SAME organiser
 *   (from any other campaign): REORDER_RETAINED, carrying forward the
 *   original acquisitionCampaignId/acquiredAt/expiry unchanged (AT-45 —
 *   "reorder within attribution period retains original organiser
 *   attribution"). repeatCampaignParentId points at the immediate prior
 *   participation, forming a chain back to the true original acquisition.
 * - Otherwise: a fresh, independent acquisition credited to THIS campaign's
 *   organiser (AT-46 — "independent join of another organiser campaign
 *   attributes to the new organiser"), with a new 12-month reference
 *   window starting now.
 */
async function computeAttribution(campaign: { id: string; organiserId: string }, userId: string): Promise<AttributionFields> {
  const organiser = await prisma.organiserProfile.findUnique({ where: { id: campaign.organiserId }, select: { userId: true } });
  if (organiser?.userId === userId) {
    return { attributionSource: "SELF" };
  }

  const now = new Date();
  const priorAcquisition = await prisma.campaignParticipant.findFirst({
    where: { userId, acquisitionOrganiserId: campaign.organiserId, organiserAttributionExpiresAt: { gt: now } },
    orderBy: { acquiredAt: "desc" },
  });

  if (priorAcquisition?.acquisitionOrganiserId && priorAcquisition.acquisitionCampaignId && priorAcquisition.acquiredAt && priorAcquisition.organiserAttributionExpiresAt) {
    return {
      acquisitionOrganiserId: priorAcquisition.acquisitionOrganiserId,
      acquisitionCampaignId: priorAcquisition.acquisitionCampaignId,
      acquiredAt: priorAcquisition.acquiredAt,
      organiserAttributionExpiresAt: priorAcquisition.organiserAttributionExpiresAt,
      attributionSource: "REORDER_RETAINED",
      repeatCampaignParentId: priorAcquisition.id,
    };
  }

  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + ATTRIBUTION_WINDOW_MONTHS);
  return {
    acquisitionOrganiserId: campaign.organiserId,
    acquisitionCampaignId: campaign.id,
    acquiredAt: now,
    organiserAttributionExpiresAt: expiresAt,
    attributionSource: "DIRECT_JOIN",
  };
}

/**
 * The ONLY place a CampaignParticipant row is ever created — both payment
 * modes' join()/pledge()/pledgeOrganiserTopUp()/requestHold() call this
 * instead of upserting CampaignParticipant directly, so attribution is
 * computed exactly once, consistently, regardless of entry point.
 * Idempotent: an existing row's attribution is NEVER recomputed or
 * overwritten by a repeat call — the spec names no organiser- or
 * participant-facing "change attribution" action, only an admin
 * investigation outcome (see community-buy.controller.ts's attribution
 * review endpoints), so there is no code path here that could touch it
 * after creation. update: {} always.
 */
export async function upsertParticipantWithAttribution(campaign: { id: string; organiserId: string }, userId: string): Promise<CampaignParticipant> {
  const existing = await prisma.campaignParticipant.findUnique({ where: { campaignId_userId: { campaignId: campaign.id, userId } } });
  if (existing) return existing;

  const attribution = await computeAttribution(campaign, userId);
  try {
    return await prisma.campaignParticipant.create({ data: { campaignId: campaign.id, userId, ...attribution } });
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code === "P2002") {
      // Lost a concurrent create race — the winner's row (and its already-computed attribution) is authoritative.
      return prisma.campaignParticipant.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: campaign.id, userId } } });
    }
    throw error;
  }
}

/**
 * spec §14.5 ("suspected supplier copying or solicitation is flagged for
 * admin review; do not auto-divert rewards") / AT-46. This is a MANUAL
 * admin action only — the spec describes no automatic detector, so none is
 * invented here. The one hard rule both actions enforce: neither ever
 * reassigns acquisitionOrganiserId to a different organiser. Invalidating
 * an attribution removes its credit; it never redirects that credit
 * elsewhere, which is exactly what "do not auto-divert rewards" forbids.
 */
export const attributionReviewService = {
  async listForAdmin(status: "UNDER_REVIEW" | "INVALIDATED" | "ACTIVE" = "UNDER_REVIEW") {
    return prisma.campaignParticipant.findMany({
      where: { attributionStatus: status },
      include: { campaign: { select: { id: true, title: true } }, user: { select: { id: true, name: true, email: true } } },
      orderBy: { acquiredAt: "desc" },
    });
  },

  async flagForReview(adminId: string, participantId: string, reason: string) {
    if (!reason?.trim()) throw new AppError("reason is required", 400);
    const participant = await prisma.campaignParticipant.findUnique({ where: { id: participantId } });
    if (!participant) throw new AppError("Participant not found", 404);
    if (participant.attributionStatus === "INVALIDATED") throw new AppError("This attribution has already been invalidated", 409);
    const claim = await prisma.campaignParticipant.updateMany({
      where: { id: participantId, attributionStatus: "ACTIVE" },
      data: { attributionStatus: "UNDER_REVIEW", attributionOverrideReason: reason },
    });
    if (claim.count !== 1) throw new AppError("This attribution cannot be flagged from its current state", 409);
    await recordAudit({ actorId: adminId, action: "community_buy_attribution.flagged", entityType: "CampaignParticipant", entityId: participantId, metadata: { reason } });
    return prisma.campaignParticipant.findUniqueOrThrow({ where: { id: participantId } });
  },

  /** outcome CONFIRMED_VALID restores ACTIVE (a false alarm); INVALIDATED marks the attribution invalid PERMANENTLY — never reassigned to another organiser. */
  async resolveReview(adminId: string, participantId: string, outcome: "CONFIRMED_VALID" | "INVALIDATED", reason: string) {
    if (!reason?.trim()) throw new AppError("reason is required", 400);
    const participant = await prisma.campaignParticipant.findUnique({ where: { id: participantId } });
    if (!participant) throw new AppError("Participant not found", 404);
    if (participant.attributionStatus !== "UNDER_REVIEW") throw new AppError("This attribution is not currently under review", 409);
    const nextStatus = outcome === "CONFIRMED_VALID" ? "ACTIVE" : "INVALIDATED";
    const claim = await prisma.campaignParticipant.updateMany({
      where: { id: participantId, attributionStatus: "UNDER_REVIEW" },
      data: { attributionStatus: nextStatus, attributionOverrideReason: reason },
    });
    if (claim.count !== 1) throw new AppError("This attribution cannot be resolved from its current state", 409);
    await recordAudit({ actorId: adminId, action: "community_buy_attribution.review_resolved", entityType: "CampaignParticipant", entityId: participantId, metadata: { outcome, reason } });
    return prisma.campaignParticipant.findUniqueOrThrow({ where: { id: participantId } });
  },
};
