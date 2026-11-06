import type { Request, Response } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { EVENT_NAMES, eventsService } from "../events/events.service";
import { notificationsService } from "../notifications/notifications.service";

/** Handbook 10.2: only these states can move to disputed. */
const DISPUTABLE_STATUSES = ["FULFILLING", "COMPLETED"];
/** A participant's issue about money or delivery holds the release until someone reviews it. */
const HOLDING_CASE_TYPES = ["PAYMENT_ISSUE", "REFUND_ISSUE", "FULFILMENT_ISSUE", "SUPPLIER_CONDUCT"] as const;
const OPEN_CASE_STATUSES = ["OPEN", "IN_PROGRESS", "ESCALATED"] as const;

/**
 * Handbook 10.4 and Community Buy Part J: a dispute may hold supplier payment.
 * Checked at each release, never cached, so a case opened a moment before
 * still stops the money.
 */
export async function campaignDisputeBlockers(campaignId: string): Promise<string[]> {
  const [campaign, openCases] = await Promise.all([
    prisma.communityCampaign.findUnique({ where: { id: campaignId }, select: { disputedAt: true } }),
    prisma.communityBuySupportCase.count({
      where: { campaignId, caseType: { in: [...HOLDING_CASE_TYPES] }, status: { in: [...OPEN_CASE_STATUSES] } },
    }),
  ]);
  const blockers: string[] = [];
  if (campaign?.disputedAt) blockers.push("campaign_disputed");
  if (openCases > 0) blockers.push("open_participant_issue");
  return blockers;
}

export async function assertNoCampaignDispute(campaignId: string): Promise<void> {
  const blockers = await campaignDisputeBlockers(campaignId);
  if (blockers.length > 0) {
    throw new AppError(
      "This Community Buy has an open dispute or participant issue. Resolve it before releasing money.",
      409,
      { blockers },
      "CAMPAIGN_DISPUTE_HOLD",
    );
  }
}

async function notifyParties(campaignId: string, event: "disputed" | "dispute_resolved", title: string, body: string, suffix: string) {
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id: campaignId },
    select: { organiser: { select: { userId: true } }, supplierAccount: { select: { userId: true } }, supplier: { select: { vendor: { select: { userId: true } } } } },
  });
  const userIds = new Set([campaign?.organiser?.userId, campaign?.supplierAccount?.userId, campaign?.supplier?.vendor?.userId].filter((id): id is string => Boolean(id)));
  for (const userId of userIds) {
    try {
      await notificationsService.enqueue({
        userId,
        type: "COMMUNITY_CAMPAIGN_UPDATE",
        title,
        body,
        data: { type: "community_campaign_update", event, campaignId },
        dedupeKey: `community_buy_${event}:${campaignId}:${userId}:${suffix}`,
      });
    } catch (error) {
      logger.warn("Community Buy dispute notification wasn't sent", { campaignId, event, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const campaignDisputeService = {
  async open(adminId: string, campaignId: string, rawReason: unknown, request?: Request) {
    const reason = requireAuditReason(rawReason);
    const claim = await prisma.communityCampaign.updateMany({
      where: { id: campaignId, disputedAt: null, status: { in: DISPUTABLE_STATUSES as never } },
      data: { disputedAt: new Date(), disputedById: adminId, disputeReason: reason },
    });
    if (claim.count !== 1) {
      const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, select: { disputedAt: true } });
      if (!campaign) throw new AppError("Campaign not found", 404);
      if (campaign.disputedAt) throw new AppError("This Community Buy is already disputed.", 409, undefined, "ALREADY_DISPUTED");
      throw new AppError("A Community Buy can only be disputed during fulfilment or after completion.", 409, undefined, "NOT_DISPUTABLE");
    }
    await recordAudit({ actorId: adminId, action: "community_campaign.disputed", entityType: "CommunityCampaign", entityId: campaignId, reason, request });
    eventsService.emit({ name: EVENT_NAMES.dispute_opened, actorType: "admin", actorId: adminId, entityType: "CommunityCampaign", entityId: campaignId, source: "admin_web" });
    await notifyParties(campaignId, "disputed", "Community Buy under review", "Eki is reviewing a dispute on this Community Buy. Supplier payment is on hold until it's resolved.", String(Date.now()));
    return prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  },

  async resolve(adminId: string, campaignId: string, rawReason: unknown, request?: Request) {
    const reason = requireAuditReason(rawReason);
    const claim = await prisma.communityCampaign.updateMany({
      where: { id: campaignId, disputedAt: { not: null } },
      data: { disputedAt: null, disputedById: null, disputeReason: null },
    });
    if (claim.count !== 1) throw new AppError("This Community Buy isn't disputed.", 409, undefined, "NOT_DISPUTED");
    await recordAudit({ actorId: adminId, action: "community_campaign.dispute_resolved", entityType: "CommunityCampaign", entityId: campaignId, reason, request });
    eventsService.emit({ name: EVENT_NAMES.dispute_resolved, actorType: "admin", actorId: adminId, entityType: "CommunityCampaign", entityId: campaignId, source: "admin_web" });
    await notifyParties(campaignId, "dispute_resolved", "Community Buy review finished", "Eki has finished reviewing this Community Buy.", String(Date.now()));
    return prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  },
};

function campaignIdOf(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || !id) throw new AppError("Invalid id", 400);
  return id;
}

export async function adminDisputeCampaign(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const campaign = await campaignDisputeService.open(request.user.id, campaignIdOf(request), (request.body as { reason?: unknown })?.reason, request);
  response.status(200).json({ campaign });
}

export async function adminResolveCampaignDispute(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const campaign = await campaignDisputeService.resolve(request.user.id, campaignIdOf(request), (request.body as { reason?: unknown })?.reason, request);
  response.status(200).json({ campaign });
}
