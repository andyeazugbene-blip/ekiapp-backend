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
  minimumShares: number;
  goalShares: number;
  maximumShares: number;
  pricePerShareMinor: number;
  deadline: string;
  rescueDurationMinutes?: number;
}

const MAX_EXTENSIONS = 1;

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

    // Flexible-fulfilment quantity model validation — doc §5.
    if (!Number.isInteger(input.minimumShares) || input.minimumShares < 1) {
      throw new AppError("Minimum shares must be at least 1", 400);
    }
    if (!Number.isInteger(input.goalShares) || input.goalShares < input.minimumShares) {
      throw new AppError("Campaign goal must be at least the minimum shares", 400);
    }
    if (!Number.isInteger(input.maximumShares) || input.maximumShares < input.goalShares) {
      throw new AppError("Maximum capacity must be at least the campaign goal", 400);
    }
    if (!Number.isInteger(input.pricePerShareMinor) || input.pricePerShareMinor <= 0) {
      throw new AppError("Price per share must be positive", 400);
    }
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
        // targetAmount kept in sync with goalShares × price for anything
        // still reading the amount-based field during the UI migration.
        targetAmount: input.goalShares * input.pricePerShareMinor,
        minimumShares: input.minimumShares,
        goalShares: input.goalShares,
        maximumShares: input.maximumShares,
        pricePerShareMinor: input.pricePerShareMinor,
        rescueDurationMinutes: input.rescueDurationMinutes ?? 2880,
        deadline,
        status: "DRAFT",
      },
    });
  },

  async update(userId: string, campaignId: string, input: Partial<CreateCampaignInput>) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    // spec §8.10 / doc §Screen 102: an organiser cannot edit financial
    // terms after contributions begin — termsLockedAt is set on the first
    // confirmed contribution (see campaign-contributions.service.ts).
    if (campaign.status !== "DRAFT" && campaign.status !== "CHANGES_REQUIRED") {
      throw new AppError("This campaign can no longer be edited", 409);
    }
    if (campaign.termsLockedAt) {
      throw new AppError("This campaign's terms are locked after the first confirmed contribution", 409);
    }
    return prisma.communityCampaign.update({
      where: { id: campaignId },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.minimumShares !== undefined && { minimumShares: input.minimumShares }),
        ...(input.goalShares !== undefined && { goalShares: input.goalShares }),
        ...(input.maximumShares !== undefined && { maximumShares: input.maximumShares }),
        ...(input.pricePerShareMinor !== undefined && {
          pricePerShareMinor: input.pricePerShareMinor,
          targetAmount: (input.goalShares ?? campaign.goalShares ?? 0) * input.pricePerShareMinor,
        }),
        ...(input.deadline !== undefined && { deadline: new Date(input.deadline) }),
      },
    });
  },

  /** Supplier-side commitment — doc screens 115-117. Required before the organiser can submit for admin review. */
  async confirmSupplierCommitment(vendorId: string, campaignId: string) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !supplier || campaign.supplierId !== supplier.id) {
      throw new AppError("Campaign not found", 404);
    }
    if (campaign.status !== "DRAFT" && campaign.status !== "CHANGES_REQUIRED") {
      throw new AppError("This campaign is not awaiting supplier commitment", 409);
    }
    return prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { supplierCommitted: true, supplierCommittedAt: new Date() },
    });
  },

  async submit(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "DRAFT" && campaign.status !== "CHANGES_REQUIRED") {
      throw new AppError("Only a draft campaign can be submitted for review", 409);
    }
    if (!campaign.supplierCommitted) {
      throw new AppError("The supplier must accept this campaign before it can be submitted for review", 409);
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
        contributions: { where: { status: "PAID" }, select: { amount: true, quantity: true } },
        _count: { select: { participants: true } },
      },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);
    const paidTotal = campaign.contributions.reduce((sum, c) => sum + c.amount, 0);
    // confirmedShares is the authoritative, atomically-maintained count
    // (see campaign-contributions.service.ts) — this is only a display
    // cross-check, never used to decide success/failure.
    const goal = campaign.goalShares ?? 0;
    const progressPct = goal > 0 ? Math.min(100, Math.round((campaign.confirmedShares / goal) * 100)) : 0;
    return { ...campaign, paidTotal, progressPct, participantCount: campaign._count.participants };
  },

  // ─── Closing workflow — doc §7 Deadline Evaluation ─────────────────────
  // Financial success/failure is always decided here, server-side, from
  // the authoritative confirmedShares counter — never from the progress
  // bar or a client-reported state.
  //
  //   confirmed >= goal      -> GOAL_REACHED, proceed (FULFILLING)
  //   confirmed >= minimum   -> MINIMUM_REACHED, proceed (FULFILLING)
  //   confirmed <  minimum   -> RESCUE_WINDOW opens, no supplier order yet

  async closeDueCampaigns(): Promise<{ closed: number; succeeded: number; failed: number; rescued: number }> {
    const due = await prisma.communityCampaign.findMany({
      where: { status: "LIVE", deadline: { lte: new Date() } },
    });

    let succeeded = 0;
    let failed = 0;
    let rescued = 0;
    for (const campaign of due) {
      const minimum = campaign.minimumShares ?? 0;
      const goal = campaign.goalShares ?? 0;

      if (campaign.confirmedShares >= minimum) {
        const outcome = campaign.confirmedShares >= goal ? "GOAL_REACHED" : "MINIMUM_REACHED";
        await prisma.communityCampaign.update({
          where: { id: campaign.id },
          data: { status: "FULFILLING", fundingOutcome: outcome, closedAt: new Date() },
        });
        succeeded++;
        await this.notifyOutcome(campaign.id, "succeeded");
        await this.createSupplierOrder(campaign);
      } else {
        rescued++;
        const rescueEndsAt = new Date(Date.now() + (campaign.rescueDurationMinutes ?? 2880) * 60 * 1000);
        await prisma.communityCampaign.update({
          where: { id: campaign.id },
          data: { status: "RESCUE_WINDOW", rescueEndsAt },
        });
        await this.notifyRescueOpened(campaign.id, rescueEndsAt);
      }
    }
    return { closed: due.length, succeeded, failed, rescued };
  },

  /** One supplier order per campaign, using the actual final confirmedShares — never the goal — doc §11. */
  async createSupplierOrder(campaign: { id: string; supplierId: string; title: string; currency: string; confirmedShares: number; pricePerShareMinor: number | null }): Promise<void> {
    if (!campaign.pricePerShareMinor) return;
    const existing = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId: campaign.id } });
    if (existing) return; // idempotent — never create a second supplier order/payment record.

    const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId }, include: { vendor: true } });
    const amount = campaign.confirmedShares * campaign.pricePerShareMinor;
    await prisma.campaignSupplierPayment.create({
      data: {
        campaignId: campaign.id,
        amount,
        currency: campaign.currency,
        status: "NOT_RELEASED",
        payoutStripeAccountIdAtApproval: supplier?.vendor.stripeAccountId ?? null,
      },
    });
    if (supplier) {
      await notifyCampaign(supplier.vendor.userId, "supplier_order_created", "Campaign order confirmed", `${campaign.title} reached its funding requirement. Final quantity: ${campaign.confirmedShares}.`, campaign.id);
    }
  },

  async notifyRescueOpened(campaignId: string, rescueEndsAt: Date): Promise<void> {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: { organiser: true, participants: true },
    });
    if (!campaign) return;
    const remaining = Math.max(0, (campaign.minimumShares ?? 0) - campaign.confirmedShares);
    const body = `${campaign.title} needs ${remaining} more share(s) to proceed. The organiser has until ${rescueEndsAt.toISOString()} to act.`;
    await notifyCampaign(campaign.organiser.userId, "rescue_opened", "Campaign needs more participants", body, campaignId);
    for (const p of campaign.participants) {
      await notifyCampaign(p.userId, "rescue_opened", "Campaign needs more participants", body, campaignId);
    }
  },

  // ─── Rescue-window actions — doc §8 ─────────────────────────────────────
  // "Fulfil anyway below the supplier-approved minimum" is explicitly
  // forbidden by the spec. The only ways out of RESCUE_WINDOW are: an
  // organiser top-up purchase (campaign-contributions.service.ts —
  // ordinary paid checkout, re-evaluated atomically on confirmation),
  // inviting more participants (no server action needed), one
  // admin-approved extension, or ending the campaign into refunds.

  /** Evaluates campaigns whose rescue window has expired — run from the cron sweep alongside closeDueCampaigns(). */
  async evaluateRescueExpiry(): Promise<{ rescued: number; failed: number }> {
    const expired = await prisma.communityCampaign.findMany({
      where: { status: "RESCUE_WINDOW", rescueEndsAt: { lte: new Date() } },
    });
    let rescued = 0;
    let failed = 0;
    for (const campaign of expired) {
      const minimum = campaign.minimumShares ?? 0;
      const goal = campaign.goalShares ?? 0;
      if (campaign.confirmedShares >= minimum) {
        // A top-up or a newly confirmed participant pushed this over the
        // line before the window closed — proceed exactly like a normal
        // on-time success.
        const outcome = campaign.confirmedShares >= goal ? "GOAL_REACHED" : "MINIMUM_REACHED";
        await prisma.communityCampaign.update({
          where: { id: campaign.id },
          data: { status: "FULFILLING", fundingOutcome: outcome },
        });
        rescued++;
        await this.notifyOutcome(campaign.id, "succeeded");
        await this.createSupplierOrder(campaign);
      } else {
        await prisma.communityCampaign.update({
          where: { id: campaign.id },
          data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() },
        });
        failed++;
        await this.notifyOutcome(campaign.id, "failed");
        await this.createRefundRecordsForFailedCampaign(campaign.id);
      }
    }
    return { rescued, failed };
  },

  /** Organiser ends the campaign during its rescue window instead of waiting it out — doc Screen 105. */
  async endRescueAndRefund(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "RESCUE_WINDOW") {
      throw new AppError("Only a campaign in its rescue window can be ended this way", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() },
    });
    await this.createRefundRecordsForFailedCampaign(campaignId);
    await notifyCampaign(userId, "cancelled", "Campaign ended", `${campaign.title} has been ended. Refunds are being processed for anyone who contributed.`, campaignId);
    const participants = await prisma.campaignParticipant.findMany({ where: { campaignId }, select: { userId: true } });
    for (const p of participants) {
      await notifyCampaign(p.userId, "cancelled", "Campaign ended", `${campaign.title} has ended. Any contribution you made will be refunded.`, campaignId);
      await automationService.scheduleAutomation({
        type: "CAMPAIGN_REFUND_UPDATE",
        recipientUserId: p.userId,
        subjectKey: `${campaignId}:cancelled`,
        requiresMarketingConsent: false,
        title: "Campaign ended",
        body: `${campaign.title} has ended. Your refund is being processed.`,
        data: { campaign_title: campaign.title, refund_status: "processing" },
      });
    }
    return updated;
  },

  /** Doc Screen 108 — one extension maximum, admin-approved, requires supplier reconfirmation. */
  async requestExtension(
    userId: string,
    campaignId: string,
    input: { requestedDeadline: string; reason: string; supplierReconfirmed: boolean; priceUnchangedConfirmed: boolean; participantTermsUnchanged: boolean },
  ) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "RESCUE_WINDOW") {
      throw new AppError("An extension can only be requested while a campaign is in its rescue window", 409);
    }
    if (campaign.extensionCount >= MAX_EXTENSIONS) {
      throw new AppError("This campaign has already used its permitted extension", 409);
    }
    const requestedDeadline = new Date(input.requestedDeadline);
    if (Number.isNaN(requestedDeadline.getTime()) || requestedDeadline <= new Date()) {
      throw new AppError("Requested deadline must be a valid future date", 400);
    }
    return prisma.campaignExtensionRequest.create({
      data: {
        campaignId,
        requestedDeadline,
        reason: input.reason,
        supplierReconfirmed: input.supplierReconfirmed,
        priceUnchangedConfirmed: input.priceUnchangedConfirmed,
        participantTermsUnchanged: input.participantTermsUnchanged,
        status: "PENDING",
      },
    });
  },

  async approveExtension(adminId: string, requestId: string) {
    const request = await prisma.campaignExtensionRequest.findUnique({ where: { id: requestId }, include: { campaign: { include: { organiser: true, participants: true } } } });
    if (!request) throw new AppError("Extension request not found", 404);
    if (request.status !== "PENDING") throw new AppError("This extension request has already been decided", 409);
    if (request.campaign.extensionCount >= MAX_EXTENSIONS) throw new AppError("This campaign has already used its permitted extension", 409);
    if (!request.supplierReconfirmed || !request.priceUnchangedConfirmed) {
      throw new AppError("Supplier reconfirmation and price-unchanged confirmation are required before approval", 400);
    }

    await prisma.$transaction([
      prisma.campaignExtensionRequest.update({ where: { id: requestId }, data: { status: "APPROVED", reviewedById: adminId, reviewedAt: new Date() } }),
      prisma.communityCampaign.update({
        where: { id: request.campaignId },
        data: { status: "LIVE", deadline: request.requestedDeadline, rescueEndsAt: null, extensionCount: { increment: 1 } },
      }),
    ]);

    const body = `${request.campaign.title}'s deadline has been extended to ${request.requestedDeadline.toISOString()}.`;
    await notifyCampaign(request.campaign.organiser.userId, "extension_approved", "Campaign extended", body, request.campaignId);
    for (const p of request.campaign.participants) {
      await notifyCampaign(p.userId, "extension_approved", "Campaign extended", body, request.campaignId);
    }
    return prisma.campaignExtensionRequest.findUnique({ where: { id: requestId } });
  },

  async rejectExtension(adminId: string, requestId: string, notes?: string) {
    const request = await prisma.campaignExtensionRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError("Extension request not found", 404);
    if (request.status !== "PENDING") throw new AppError("This extension request has already been decided", 409);
    return prisma.campaignExtensionRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED", reviewedById: adminId, reviewedAt: new Date(), reviewNotes: notes },
    });
  },

  async listExtensionRequestsForAdmin() {
    return prisma.campaignExtensionRequest.findMany({
      where: { status: "PENDING" },
      include: { campaign: { select: { id: true, title: true, confirmedShares: true, minimumShares: true } } },
      orderBy: { createdAt: "asc" },
    });
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
