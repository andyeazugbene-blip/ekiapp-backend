import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { notificationsService } from "../notifications/notifications.service";

/**
 * Handbook 10.4 - participant notifications that were missing (campaign
 * live, progress milestone, closing soon for non-participants, completed).
 * Every send is frequency-controlled with a deterministic dedupeKey, so a
 * repeated sweep or webhook retry can never double-notify, and every
 * function is best effort (never throws into the business operation).
 */

export const MILESTONES = [25, 50, 75, 100] as const;
/** Discovery pushes are capped so a popular market is never blasted. */
export const DISCOVERY_AUDIENCE_CAP = 200;

/** Highest milestone (25/50/75/100) reached by the given progress, or null below 25%. */
export function milestoneFor(confirmedShares: number, goalShares: number | null, minimumShares: number | null): 25 | 50 | 75 | 100 | null {
  const target = goalShares ?? minimumShares ?? 0;
  if (target <= 0) return null;
  const pct = Math.floor((confirmedShares / target) * 100);
  let reached: (typeof MILESTONES)[number] | null = null;
  for (const m of MILESTONES) if (pct >= m) reached = m;
  return reached;
}

async function send(userId: string, event: string, title: string, body: string, campaignId: string, dedupeKey: string, audience?: "organiser") {
  await notificationsService.enqueue({
    userId,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title,
    body,
    data: { type: "community_campaign_update", event, campaignId, ...(audience ? { audience } : {}) },
    dedupeKey,
  });
}

/** Users who already took part in a Community Buy campaign in the same market - the "eligible" discovery audience. */
async function eligibleDiscoveryAudience(campaignId: string, country: string | null, organiserUserId: string): Promise<string[]> {
  if (!country) return [];
  const already = await prisma.campaignParticipant.findMany({ where: { campaignId }, select: { userId: true } });
  const exclude = new Set<string>([organiserUserId, ...already.map((p) => p.userId)]);
  const rows = await prisma.campaignParticipant.findMany({
    where: { campaign: { country }, user: { isSuspended: false } },
    distinct: ["userId"],
    select: { userId: true },
    take: DISCOVERY_AUDIENCE_CAP + exclude.size,
  });
  return rows.map((r) => r.userId).filter((id) => !exclude.has(id)).slice(0, DISCOVERY_AUDIENCE_CAP);
}

export async function notifyProgressMilestone(campaignId: string): Promise<void> {
  try {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      select: { title: true, confirmedShares: true, goalShares: true, minimumShares: true, organiser: { select: { userId: true } }, participants: { select: { userId: true } } },
    });
    if (!campaign) return;
    const milestone = milestoneFor(campaign.confirmedShares, campaign.goalShares, campaign.minimumShares);
    if (!milestone) return;
    const title = milestone === 100 ? "Campaign target reached" : `Campaign is ${milestone}% funded`;
    const body = milestone === 100 ? `${campaign.title} has reached its target.` : `${campaign.title} has reached ${milestone}% of its target.`;
    const recipients = new Set<string>([campaign.organiser.userId, ...campaign.participants.map((p) => p.userId)]);
    for (const userId of recipients) {
      await send(userId, "milestone_reached", title, body, campaignId, `milestone:${campaignId}:${milestone}:${userId}`, userId === campaign.organiser.userId ? "organiser" : undefined);
    }
  } catch (error) {
    logger.error("Milestone notification failed (non-blocking)", { campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

export async function notifyCampaignLiveDiscovery(campaignId: string): Promise<void> {
  try {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, select: { title: true, country: true, organiser: { select: { userId: true } } } });
    if (!campaign) return;
    const audience = await eligibleDiscoveryAudience(campaignId, campaign.country, campaign.organiser.userId);
    for (const userId of audience) {
      await send(userId, "campaign_live", "A new Community Buy is live", `${campaign.title} is now open. Take a look and join before it closes.`, campaignId, `campaign_live:${campaignId}:${userId}`);
    }
  } catch (error) {
    logger.error("Campaign-live discovery notification failed (non-blocking)", { campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

/** Closing-soon reminder to eligible NON-participants (participants already get the automation reminder). */
export async function notifyClosingSoonDiscovery(campaignId: string): Promise<void> {
  try {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, select: { title: true, country: true, organiser: { select: { userId: true } } } });
    if (!campaign) return;
    const audience = await eligibleDiscoveryAudience(campaignId, campaign.country, campaign.organiser.userId);
    for (const userId of audience) {
      await send(userId, "closing_soon", "Community Buy closing soon", `${campaign.title} closes within 24 hours.`, campaignId, `closing_soon:${campaignId}:${userId}`);
    }
  } catch (error) {
    logger.error("Closing-soon discovery notification failed (non-blocking)", { campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

/** Handbook 10.4 "Completed": participants can confirm receipt, raise an issue or review. */
export async function notifyCampaignCompleted(campaignId: string): Promise<void> {
  try {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      select: { title: true, organiser: { select: { userId: true } }, participants: { select: { userId: true } } },
    });
    if (!campaign) return;
    for (const p of campaign.participants) {
      await send(p.userId, "completed", "Your Community Buy is complete", `${campaign.title} is complete. Confirm you received your order, report a problem, or leave a review.`, campaignId, `completed:${campaignId}:${p.userId}`);
    }
    await send(campaign.organiser.userId, "completed", "Your campaign is complete", `${campaign.title} is complete.`, campaignId, `completed:${campaignId}:${campaign.organiser.userId}`, "organiser");
  } catch (error) {
    logger.error("Completed notification failed (non-blocking)", { campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}
