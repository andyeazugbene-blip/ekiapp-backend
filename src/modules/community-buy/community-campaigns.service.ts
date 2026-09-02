import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { automationService } from "../automation/automation.service";
import { marketConfigurationService } from "./market-configuration.service";

export interface CreateCampaignInput {
  supplierId: string;
  title: string;
  description?: string;
  country: string;
  currency: string;
  targetAmount: number;
  deadline: string;
}

async function notifyCampaign(userId: string, event: string, title: string, body: string, campaignId: string) {
  await notificationsService.enqueue({
    userId,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title,
    body,
    data: { type: "community_campaign_update", event, campaignId },
  });
}

export const communityCampaignsService = {
  async create(userId: string, input: CreateCampaignInput) {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    if (!organiser || !organiser.isVerified) throw new AppError("Verified organiser profile required", 403);

    const config = await marketConfigurationService.get(input.country);
    if (!config?.communityBuyEnabled) throw new AppError("Community Buy is not available in this market yet", 403);

    const supplier = await prisma.supplierProfile.findUnique({ where: { id: input.supplierId } });
    if (!supplier || !supplier.isVerified) throw new AppError("Supplier not found or not verified", 404);
    if (supplier.country !== input.country) {
      // spec §8.2: campaigns operate as a local-market feature only — no
      // cross-border organiser/supplier pairing in this version.
      throw new AppError("Supplier must be based in the same market as the campaign", 400);
    }
    if (input.targetAmount <= 0) throw new AppError("Target amount must be positive", 400);
    const deadline = new Date(input.deadline);
    if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) {
      throw new AppError("Deadline must be a valid future date", 400);
    }

    return prisma.communityCampaign.create({
      data: {
        organiserId: organiser.id,
        supplierId: input.supplierId,
        title: input.title,
        description: input.description,
        country: input.country,
        currency: input.currency,
        targetAmount: input.targetAmount,
        deadline,
        status: "DRAFT",
      },
    });
  },

  async update(userId: string, campaignId: string, input: Partial<CreateCampaignInput>) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    // spec §8.10: an organiser cannot edit financial terms after
    // contributions begin.
    if (campaign.status !== "DRAFT" && campaign.status !== "CHANGES_REQUIRED") {
      throw new AppError("This campaign can no longer be edited", 409);
    }
    return prisma.communityCampaign.update({
      where: { id: campaignId },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.targetAmount !== undefined && { targetAmount: input.targetAmount }),
        ...(input.deadline !== undefined && { deadline: new Date(input.deadline) }),
      },
    });
  },

  async submit(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "DRAFT" && campaign.status !== "CHANGES_REQUIRED") {
      throw new AppError("Only a draft campaign can be submitted for review", 409);
    }
    return prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "UNDER_REVIEW" } });
  },

  async requireOwnedByOrganiser(userId: string, campaignId: string) {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !organiser || campaign.organiserId !== organiser.id) {
      throw new AppError("Campaign not found", 404);
    }
    return campaign;
  },

  // ─── Admin review ─────────────────────────────────────────────────────

  async listForReview() {
    return prisma.communityCampaign.findMany({
      where: { status: "UNDER_REVIEW" },
      include: { organiser: { include: { user: { select: { name: true, email: true } } } }, supplier: { include: { vendor: { select: { storeName: true } } } } },
      orderBy: { createdAt: "asc" },
    });
  },

  /** Admin visibility into how campaigns actually closed — the review queue only ever shows UNDER_REVIEW, so this is the only place an admin can see a FAILED campaign awaiting an organiser decision, or the outcome once one's been made. */
  async listRecentlyClosed(limit = 50) {
    return prisma.communityCampaign.findMany({
      where: { status: { in: ["SUCCEEDED", "FAILED", "FULFILLING", "CANCELLED"] } },
      include: { organiser: { include: { user: { select: { name: true, email: true } } } }, supplier: { include: { vendor: { select: { storeName: true } } } } },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
  },

  async approve(adminId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "UNDER_REVIEW") throw new AppError("Campaign is not under review", 409);
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "APPROVED", reviewedById: adminId, reviewedAt: new Date() },
    });
    await notifyCampaign(campaign.organiser.userId, "approved", "Campaign approved", `${campaign.title} has been approved.`, campaignId);
    return updated;
  },

  async requestChanges(adminId: string, campaignId: string, notes: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "UNDER_REVIEW") throw new AppError("Campaign is not under review", 409);
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "CHANGES_REQUIRED", reviewNotes: notes, reviewedById: adminId, reviewedAt: new Date() },
    });
    await notifyCampaign(campaign.organiser.userId, "changes_requested", "Campaign changes requested", notes, campaignId);
    return updated;
  },

  async reject(adminId: string, campaignId: string, notes?: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "UNDER_REVIEW") throw new AppError("Campaign is not under review", 409);
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "REJECTED", reviewNotes: notes, reviewedById: adminId, reviewedAt: new Date() },
    });
    await notifyCampaign(campaign.organiser.userId, "rejected", "Campaign rejected", notes ?? "Your campaign was not approved.", campaignId);
    return updated;
  },

  async pause(adminId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "LIVE") throw new AppError("Only a live campaign can be paused", 409);
    return prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
  },

  async resume(adminId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "PAUSED") throw new AppError("Only a paused campaign can be resumed", 409);
    return prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "LIVE" } });
  },

  // ─── Publishing & discovery ────────────────────────────────────────────

  async publish(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "APPROVED") throw new AppError("Campaign must be approved before it can be published", 409);
    const config = await marketConfigurationService.get(campaign.country);
    if (!config?.communityBuyEnabled) throw new AppError("Community Buy is not available in this market yet", 403);
    return prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "LIVE", publishedAt: new Date() } });
  },

  async listLive(country?: string) {
    return prisma.communityCampaign.findMany({
      where: { status: "LIVE", ...(country && { country }) },
      include: { supplier: { include: { vendor: { select: { storeName: true } } } } },
      orderBy: { deadline: "asc" },
    });
  },

  async listForOrganiser(userId: string) {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    if (!organiser) return [];
    const campaigns = await prisma.communityCampaign.findMany({
      where: { organiserId: organiser.id },
      include: {
        supplier: { include: { vendor: { select: { storeName: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true } },
        _count: { select: { participants: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return campaigns.map((c) => ({ ...c, participantCount: c._count.participants }));
  },

  async listForSupplier(vendorId: string) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    if (!supplier) return [];
    return prisma.communityCampaign.findMany({
      where: { supplierId: supplier.id },
      include: {
        organiser: { include: { user: { select: { name: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  async get(campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: {
        supplier: { include: { vendor: { select: { storeName: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true } },
        _count: { select: { participants: true } },
      },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);
    const paidTotal = campaign.contributions.reduce((sum, c) => sum + c.amount, 0);
    const progressPct = campaign.targetAmount > 0 ? Math.min(100, Math.round((paidTotal / campaign.targetAmount) * 100)) : 0;
    return { ...campaign, paidTotal, progressPct, participantCount: campaign._count.participants };
  },

  // ─── Closing workflow — spec §8.7/§8.8/§8.9 ────────────────────────────
  // Financial success/failure is always decided here, server-side, from
  // reconciled PAID contribution totals — never from the progress bar or
  // a client-reported state, per spec §22 Definition of Done.

  async closeDueCampaigns(): Promise<{ closed: number; succeeded: number; failed: number }> {
    const due = await prisma.communityCampaign.findMany({
      where: { status: "LIVE", deadline: { lte: new Date() } },
      include: { contributions: { where: { status: "PAID" }, select: { amount: true } } },
    });

    let succeeded = 0;
    let failed = 0;
    for (const campaign of due) {
      const paidTotal = campaign.contributions.reduce((sum, c) => sum + c.amount, 0);
      const wasSuccessful = paidTotal >= campaign.targetAmount;

      await prisma.communityCampaign.update({
        where: { id: campaign.id },
        data: {
          status: wasSuccessful ? "SUCCEEDED" : "FAILED",
          paidTotal,
          closedAt: new Date(),
        },
      });

      if (wasSuccessful) {
        succeeded++;
        await this.notifyOutcome(campaign.id, "succeeded");
      } else {
        failed++;
        await this.notifyOutcome(campaign.id, "failed");
        // No automatic refund here. The client hasn't confirmed what
        // "Fulfil Anyway" means financially, so a missed-target campaign
        // now waits for an explicit organiser decision (fulfilAnyway() /
        // cancelAfterFailure()) instead of assuming cancellation and
        // refunding unilaterally. Refund records are only ever created
        // from cancelAfterFailure(), once the organiser has actually
        // chosen to cancel.
      }
    }
    return { closed: due.length, succeeded, failed };
  },

  // ─── Post-failure organiser decision ───────────────────────────────────
  // A campaign that misses its target stops at FAILED and waits here. The
  // organiser is the only one who can move it forward, and only in the two
  // directions the client has actually confirmed exist: fulfil the order
  // anyway (no financial action taken — the client hasn't decided what
  // charging looks like under a missed-target fulfilment), or cancel and
  // refund (reuses the exact same refund path that already existed).

  async fulfilAnyway(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "FAILED") throw new AppError("Only a campaign that missed its target can be fulfilled anyway", 409);
    const updated = await prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "FULFILLING" } });
    // userId here is already the organiser's real User.id (validated by
    // requireOwnedByOrganiser above) — campaign.organiserId is the
    // OrganiserProfile FK, not a user, and must never be passed to a
    // notification call expecting a User.id.
    await notifyCampaign(
      userId,
      "fulfilling",
      "Campaign proceeding",
      `${campaign.title} didn't reach its target, but the organiser has chosen to proceed. No payment action has been taken — further details will follow.`,
      campaignId,
    );
    const participants = await prisma.campaignParticipant.findMany({ where: { campaignId }, select: { userId: true } });
    for (const p of participants) {
      await notifyCampaign(
        p.userId,
        "fulfilling",
        "Campaign proceeding",
        `${campaign.title} didn't reach its target, but the organiser has chosen to proceed. No payment action has been taken — further details will follow.`,
        campaignId,
      );
    }
    return updated;
  },

  async cancelAfterFailure(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "FAILED") throw new AppError("Only a campaign that missed its target can be cancelled this way", 409);
    const updated = await prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "CANCELLED" } });
    await this.createRefundRecordsForFailedCampaign(campaignId);

    await notifyCampaign(userId, "cancelled", "Campaign cancelled", `${campaign.title} has been cancelled. Refunds are being processed for anyone who contributed.`, campaignId);
    const participants = await prisma.campaignParticipant.findMany({ where: { campaignId }, select: { userId: true } });
    for (const p of participants) {
      await notifyCampaign(p.userId, "cancelled", "Campaign cancelled", `${campaign.title} has been cancelled. Any contribution you made will be refunded.`, campaignId);
      await automationService.scheduleAutomation({
        type: "CAMPAIGN_REFUND_UPDATE",
        recipientUserId: p.userId,
        subjectKey: `${campaignId}:cancelled`,
        requiresMarketingConsent: false,
        title: "Campaign cancelled",
        body: `${campaign.title} has been cancelled. Your refund is being processed.`,
        data: { campaign_title: campaign.title, refund_status: "processing" },
      });
    }
    return updated;
  },

  async createRefundRecordsForFailedCampaign(campaignId: string): Promise<number> {
    const paidContributions = await prisma.campaignContribution.findMany({
      where: { campaignId, status: "PAID" },
    });
    let created = 0;
    for (const contribution of paidContributions) {
      try {
        await prisma.campaignRefund.create({
          data: {
            contributionId: contribution.id,
            amount: contribution.amount,
            currency: contribution.currency,
            status: "REFUND_PENDING",
            idempotencyKey: `refund:${contribution.id}`,
          },
        });
        await prisma.campaignContribution.update({ where: { id: contribution.id }, data: { status: "REFUND_PENDING" } });
        created++;
      } catch (error: any) {
        if (error?.code !== "P2002") {
          logger.error("Failed to create campaign refund record", { contributionId: contribution.id, error: String(error) });
        }
      }
    }
    return created;
  },

  async notifyOutcome(campaignId: string, outcome: "succeeded" | "failed") {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: { organiser: true, supplier: true, participants: true },
    });
    if (!campaign) return;

    const title = outcome === "succeeded" ? "Campaign succeeded!" : "Campaign did not reach its target";
    // "failed" here is neutral on purpose — no refund is promised until the
    // organiser actually decides to cancel (see cancelAfterFailure above).
    const body = outcome === "succeeded" ? `${campaign.title} reached its target.` : `${campaign.title} did not reach its target. The organiser will decide what happens next.`;

    await notifyCampaign(campaign.organiser.userId, outcome, title, body, campaignId);
    if (outcome === "succeeded") {
      for (const participant of campaign.participants) {
        await notifyCampaign(participant.userId, outcome, title, body, campaignId);
        await automationService.scheduleAutomation({
          type: "CAMPAIGN_MILESTONE",
          recipientUserId: participant.userId,
          subjectKey: `${campaignId}:${outcome}`,
          requiresMarketingConsent: false,
          title,
          body,
          data: { campaign_title: campaign.title },
        });
      }
    } else {
      for (const participant of campaign.participants) {
        await notifyCampaign(participant.userId, outcome, title, body, campaignId);
      }
    }
  },

  /** Deadline-approaching reminder — separate from the closing sweep so it can run more than once per campaign. */
  async remindApproachingDeadlines(): Promise<number> {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const campaigns = await prisma.communityCampaign.findMany({
      where: { status: "LIVE", deadline: { lte: soon, gt: new Date() } },
      include: { participants: true },
    });
    let notified = 0;
    for (const campaign of campaigns) {
      for (const participant of campaign.participants) {
        await automationService.scheduleAutomation({
          type: "CAMPAIGN_DEADLINE",
          recipientUserId: participant.userId,
          subjectKey: `${campaign.id}:deadline`,
          frequencyCapDays: 3,
          requiresMarketingConsent: false,
          title: "Campaign deadline approaching",
          body: `${campaign.title} closes soon.`,
          data: { campaign_title: campaign.title },
        });
        notified++;
      }
    }
    return notified;
  },
};
