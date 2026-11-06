import { Prisma, type ReviewRequestStatus, type ReviewRequestType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { launchSettingsService, type LaunchSettingKey } from "../admin/launch-settings.service";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { communityCampaignsService } from "./community-campaigns.service";
import { notifyUserInAppAndEmail } from "./community-buy-notices";
import { supplierAccountService } from "./supplier-account.service";

const SLA_SETTING: Record<ReviewRequestType, LaunchSettingKey> = {
  SUPPLIER_ELIGIBILITY: "REVIEW_HOURS_SUPPLIER_ELIGIBILITY",
  SUPPLIER_OFFER: "REVIEW_HOURS_SUPPLIER_OFFER",
  COMMUNITY_BUY_CAMPAIGN: "REVIEW_HOURS_CAMPAIGN",
  EXTENSION: "REVIEW_HOURS_EXTENSION",
};

export const OPEN_REVIEW_STATUSES: ReviewRequestStatus[] = ["SUBMITTED", "UNDER_REVIEW", "INFO_REQUIRED"];

export const REJECTION_REASONS = [
  "Details are incomplete",
  "Price or quantities need changing",
  "Foodstuff can't be sold on Eki",
  "Wording needs changing",
  "Other",
] as const;

type OpenRequestInput = {
  type: ReviewRequestType;
  subjectType: string;
  subjectId: string;
  market: string;
  submittedById: string;
};

type Tx = Prisma.TransactionClient;

/** Two submits raced and the database's one-open-request index stopped the second. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function slaDueAt(type: ReviewRequestType, from = new Date()): Promise<Date> {
  return new Date(from.getTime() + (await launchSettingsService.get(SLA_SETTING[type])) * 3_600_000);
}

/** Who a request's subject belongs to, for notices and separation of duties. */
async function resolveSubjectOwner(request: { subjectType: string; subjectId: string }): Promise<{ ownerUserId: string | null; label: string }> {
  if (request.subjectType === "SupplierAccount") {
    const account = await prisma.supplierAccount.findUnique({ where: { id: request.subjectId }, select: { userId: true, businessName: true } });
    return { ownerUserId: account?.userId ?? null, label: account?.businessName ?? "your supplier details" };
  }
  if (request.subjectType === "SupplierOffer") {
    const offer = await prisma.supplierOffer.findUnique({
      where: { id: request.subjectId },
      select: { foodstuffName: true, supplierAccount: { select: { userId: true } } },
    });
    return { ownerUserId: offer?.supplierAccount.userId ?? null, label: offer?.foodstuffName ?? "your offer" };
  }
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id: request.subjectId },
    select: { title: true, organiser: { select: { userId: true } } },
  });
  return { ownerUserId: campaign?.organiser.userId ?? null, label: campaign?.title ?? "your Community Buy" };
}

function itemName(type: ReviewRequestType): string {
  if (type === "SUPPLIER_OFFER") return "your offer";
  if (type === "COMMUNITY_BUY_CAMPAIGN") return "your Community Buy";
  if (type === "EXTENSION") return "your extension request";
  return "your supplier details";
}

export const reviewRequestsService = {
  /**
   * The record behind every "in review" the app shows. A database index allows
   * one open request per subject, so a double tap resolves to the same row.
   */
  async open(input: OpenRequestInput, tx: Tx | typeof prisma = prisma) {
    const openWhere = { type: input.type, subjectType: input.subjectType, subjectId: input.subjectId, status: { in: OPEN_REVIEW_STATUSES } };
    const existing = await tx.reviewRequest.findFirst({ where: openWhere });
    if (existing) {
      // Fixing what the admin asked for puts the same request back in the queue, with a fresh target time.
      if (existing.status !== "INFO_REQUIRED") return existing;
      return tx.reviewRequest.update({
        where: { id: existing.id },
        data: { status: "SUBMITTED", infoMessage: null, submittedAt: new Date(), slaDueAt: await slaDueAt(input.type) },
      });
    }
    try {
      return await tx.reviewRequest.create({
        data: { ...input, status: "SUBMITTED", slaDueAt: await slaDueAt(input.type) },
      });
    } catch (error) {
      // Inside a transaction Postgres has already aborted it, so the caller has to recover.
      if (tx === prisma && isUniqueViolation(error)) {
        const winner = await prisma.reviewRequest.findFirst({ where: openWhere });
        if (winner) return winner;
      }
      throw error;
    }
  },

  /** Records an approval the auto-approval policy made, so the queue's history stays complete. */
  async recordAutoApproved(input: OpenRequestInput) {
    const now = new Date();
    return prisma.reviewRequest.create({
      data: { ...input, status: "APPROVED", autoApproved: true, decidedAt: now, slaDueAt: await slaDueAt(input.type, now) },
    });
  },

  async listQueue(filters: { type?: string; market?: string; status?: string; overdueOnly?: boolean } = {}) {
    const where: Prisma.ReviewRequestWhereInput = {
      status: filters.status ? (filters.status as ReviewRequestStatus) : { in: OPEN_REVIEW_STATUSES },
      ...(filters.type ? { type: filters.type as ReviewRequestType } : {}),
      ...(filters.market ? { market: filters.market } : {}),
      ...(filters.overdueOnly ? { slaDueAt: { lt: new Date() } } : {}),
    };
    const rows = await prisma.reviewRequest.findMany({ where, orderBy: [{ slaDueAt: "asc" }, { submittedAt: "asc" }], take: 200 });
    const now = Date.now();
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        subjectLabel: (await resolveSubjectOwner(row)).label,
        overdue: OPEN_REVIEW_STATUSES.includes(row.status) && row.slaDueAt.getTime() < now,
      })),
    );
  },

  async getDetail(id: string) {
    const request = await prisma.reviewRequest.findUnique({ where: { id } });
    if (!request) throw new AppError("Request not found", 404);
    const subject: unknown =
      request.subjectType === "SupplierAccount"
        ? await prisma.supplierAccount.findUnique({ where: { id: request.subjectId } })
        : request.subjectType === "SupplierOffer"
          ? await prisma.supplierOffer.findUnique({ where: { id: request.subjectId }, include: { supplierAccount: { select: { businessName: true, supplierState: true } } } })
          : await prisma.communityCampaign.findUnique({ where: { id: request.subjectId }, include: { supplierOffer: true } });
    const [submitter, previousDecisions, auditTrail] = await Promise.all([
      prisma.user.findUnique({
        where: { id: request.submittedById },
        select: {
          name: true, email: true, emailVerifiedAt: true, phoneVerifiedAt: true,
          capabilityGrants: { select: { capability: true, market: true, status: true } },
        },
      }),
      prisma.reviewRequest.findMany({
        where: { subjectType: request.subjectType, subjectId: request.subjectId, id: { not: id } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, decisionReason: true, decidedAt: true, autoApproved: true },
      }),
      prisma.auditLog.findMany({
        where: { entityType: "ReviewRequest", entityId: id },
        orderBy: { createdAt: "desc" },
        select: { action: true, actorId: true, reason: true, createdAt: true },
      }),
    ]);
    return { request, subject, submitter, previousDecisions, auditTrail, rejectionReasons: REJECTION_REASONS };
  },

  async requireDecidable(id: string, adminId: string) {
    const request = await prisma.reviewRequest.findUnique({ where: { id } });
    if (!request) throw new AppError("Request not found", 404);
    if (!OPEN_REVIEW_STATUSES.includes(request.status)) {
      throw new AppError("This request has already been decided.", 409, undefined, "REVIEW_ALREADY_DECIDED");
    }
    const { ownerUserId } = await resolveSubjectOwner(request);
    if (request.submittedById === adminId || ownerUserId === adminId) {
      throw new AppError("You can't decide a request you submitted or one for your own business.", 403, undefined, "REVIEW_SEPARATION_OF_DUTIES");
    }
    return request;
  },

  async approve(id: string, adminId: string) {
    const request = await this.requireDecidable(id, adminId);
    await applyApproval(request, adminId);
    const updated = await prisma.reviewRequest.update({
      where: { id },
      data: { status: "APPROVED", reviewerId: adminId, decidedAt: new Date(), decisionReason: null, infoMessage: null },
    });
    await recordAudit({
      actorId: adminId, action: "review_request.approved", entityType: "ReviewRequest", entityId: id,
      metadata: { type: request.type, subjectId: request.subjectId },
    });
    return updated;
  },

  async requestInformation(id: string, adminId: string, message: string) {
    if (!message?.trim()) throw new AppError("A message is required", 400);
    const request = await this.requireDecidable(id, adminId);
    if (request.subjectType === "SupplierOffer") {
      await prisma.supplierOffer.update({ where: { id: request.subjectId }, data: { status: "INFO_REQUIRED" } });
    }
    const updated = await prisma.reviewRequest.update({
      where: { id },
      data: { status: "INFO_REQUIRED", reviewerId: adminId, infoMessage: message.trim() },
    });
    await recordAudit({
      actorId: adminId, action: "review_request.info_required", entityType: "ReviewRequest", entityId: id, reason: message.trim(),
      metadata: { type: request.type, subjectId: request.subjectId },
    });
    const { ownerUserId } = await resolveSubjectOwner(request);
    if (ownerUserId) {
      await notifyUserInAppAndEmail({
        userId: ownerUserId,
        title: "We need one more detail",
        body: `We need one more detail before ${itemName(request.type)} goes live.`,
        event: "review_information_required",
        data: { reviewRequestId: id, subjectType: request.subjectType, subjectId: request.subjectId },
      });
    }
    return updated;
  },

  async reject(id: string, adminId: string, reasonCode: string, detail?: string) {
    if (!(REJECTION_REASONS as readonly string[]).includes(reasonCode)) {
      throw new AppError("Choose a rejection reason from the list", 400, undefined, "REJECTION_REASON_REQUIRED");
    }
    const reason = detail?.trim() ? `${reasonCode}: ${detail.trim()}` : reasonCode;
    const request = await this.requireDecidable(id, adminId);
    if (request.subjectType === "SupplierOffer") {
      await prisma.supplierOffer.update({ where: { id: request.subjectId }, data: { status: "REJECTED" } });
    } else if (request.subjectType === "SupplierAccount") {
      await supplierAccountService.reject(request.subjectId, reason, adminId);
    } else if (request.type === "COMMUNITY_BUY_CAMPAIGN") {
      // The draft is kept so the organiser can fix it and submit again.
      await prisma.communityCampaign.update({ where: { id: request.subjectId }, data: { status: "CHANGES_REQUIRED", reviewNotes: reason } });
    }
    const updated = await prisma.reviewRequest.update({
      where: { id },
      data: { status: "REJECTED", reviewerId: adminId, decidedAt: new Date(), decisionReason: reason },
    });
    await recordAudit({
      actorId: adminId, action: "review_request.rejected", entityType: "ReviewRequest", entityId: id, reason,
      metadata: { type: request.type, subjectId: request.subjectId },
    });
    const { ownerUserId, label } = await resolveSubjectOwner(request);
    if (ownerUserId) {
      await notifyUserInAppAndEmail({
        userId: ownerUserId,
        title: "Not approved yet",
        body: `${label} wasn't approved: ${reason}. You can edit and resubmit.`,
        event: "review_rejected",
        data: { reviewRequestId: id, subjectType: request.subjectType, subjectId: request.subjectId },
      });
    }
    return updated;
  },

  /** The latest request for a subject, so the app can show its true state. */
  async latestForSubject(subjectType: string, subjectId: string) {
    return prisma.reviewRequest.findFirst({
      where: { subjectType, subjectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, status: true, submittedAt: true, slaDueAt: true, decisionReason: true, infoMessage: true, autoApproved: true },
    });
  },

  async withdrawForSubject(subjectType: string, subjectId: string) {
    return prisma.reviewRequest.updateMany({
      where: { subjectType, subjectId, status: { in: OPEN_REVIEW_STATUSES } },
      data: { status: "WITHDRAWN", decidedAt: new Date() },
    });
  },
};

async function applyApproval(request: { type: ReviewRequestType; subjectId: string; market: string; submittedById: string }, adminId: string): Promise<void> {
  switch (request.type) {
    case "SUPPLIER_ELIGIBILITY": {
      const account = await supplierAccountService.approve(request.subjectId, adminId);
      await prisma.capabilityGrant.upsert({
        where: { userId_capability_market: { userId: account.userId, capability: "SUPPLIER", market: request.market } },
        create: { userId: account.userId, capability: "SUPPLIER", market: request.market, status: "ACTIVE", grantedById: adminId, grantedAt: new Date() },
        update: { status: "ACTIVE", grantedById: adminId, grantedAt: new Date(), suspendedAt: null },
      });
      return;
    }
    case "SUPPLIER_OFFER": {
      const offer = await prisma.supplierOffer.findUnique({ where: { id: request.subjectId }, include: { supplierAccount: true } });
      if (!offer) throw new AppError("Offer not found", 404);
      // Eligibility and the offer stay separate decisions, and eligibility comes first.
      if (offer.supplierAccount.supplierState !== "APPROVED") {
        throw new AppError("Approve this supplier's eligibility before approving their offer.", 409, undefined, "SUPPLIER_NOT_ELIGIBLE");
      }
      await prisma.supplierOffer.update({ where: { id: offer.id }, data: { status: "APPROVED", approvedAt: new Date() } });
      await notifyUserInAppAndEmail({
        userId: offer.supplierAccount.userId,
        title: "Your bulk offer is live",
        body: `Your bulk offer for ${offer.foodstuffName} is live. Organisers can now build Community Buys on it.`,
        event: "supplier_offer_approved",
        data: { supplierOfferId: offer.id },
      });
      return;
    }
    case "COMMUNITY_BUY_CAMPAIGN": {
      await communityCampaignsService.approve(adminId, request.subjectId);
      const campaign = await prisma.communityCampaign.findUnique({ where: { id: request.subjectId }, select: { organiser: { select: { userId: true } } } });
      if (campaign) await communityCampaignsService.publish(campaign.organiser.userId, request.subjectId);
      await notifyOfferCampaignLive(request.subjectId);
      return;
    }
    case "EXTENSION":
      // Extensions keep their own decision path, which also handles supplier reconfirmation.
      throw new AppError("Decide extension requests from the campaign's extension queue.", 409, undefined, "EXTENSION_USES_OWN_QUEUE");
  }
}

/** Tells the organiser and the offer's supplier that a campaign has gone live. Only offer-based campaigns have a supplier to tell. */
export async function notifyOfferCampaignLive(campaignId: string): Promise<void> {
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id: campaignId },
    select: { organiser: { select: { userId: true } }, supplierOffer: { select: { foodstuffName: true, supplierAccount: { select: { userId: true } } } } },
  });
  if (!campaign) return;
  await notifyUserInAppAndEmail({
    userId: campaign.organiser.userId,
    title: "Your Community Buy is live",
    body: "Your Community Buy is live. Share it to reach the minimum.",
    event: "offer_campaign_live",
    data: { campaignId },
    dedupeKey: `offer_campaign_live:${campaignId}`,
  });
  if (!campaign.supplierOffer) return;
  await notifyUserInAppAndEmail({
    userId: campaign.supplierOffer.supplierAccount.userId,
    title: "A Community Buy has started",
    body: `A Community Buy for ${campaign.supplierOffer.foodstuffName} has started on your offer.`,
    event: "offer_campaign_started",
    data: { campaignId },
    dedupeKey: `offer_campaign_started:${campaignId}`,
  });
}
