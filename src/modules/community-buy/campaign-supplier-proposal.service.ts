import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notifyCampaign, SUPPLIER_RESPONSE_STATUSES } from "./community-campaigns.service";

/**
 * Phase 5 (organiser<->supplier negotiation) — a supplier-initiated
 * proposal to change a campaign's wholesale price, maximum slots, and/or
 * target readiness date. Deliberately separate from supplierCommitted/
 * supplierDeclinedAt (community-campaigns.service.ts) — those answer "will
 * I supply this campaign at all", a one-time binary decision; this answers
 * "I'll supply it, but these specific terms need to change first", an
 * iterative negotiation that can go through several rounds before (or
 * instead of) that binary decision.
 *
 * State machine (CampaignSupplierProposal.status):
 *   SUBMITTED -> ADMIN_CHANGES_NEEDED -> SUBMITTED (resubmit, same row, revisionCount++)
 *   SUBMITTED -> AWAITING_ORGANISER -> ORGANISER_ACCEPTED | ORGANISER_REJECTED
 *   (SUBMITTED | ADMIN_CHANGES_NEEDED | AWAITING_ORGANISER) -> WITHDRAWN (supplier)
 *   (SUBMITTED | ADMIN_CHANGES_NEEDED | AWAITING_ORGANISER) -> EXPIRED (sweep, past respondByDeadline)
 *
 * Read-scoping (spec requirement 7 — "only expose to the correct
 * parties"): adminNotes is admin-to-supplier only — visible to the
 * submitting supplier (they need it to act on "changes needed") and to
 * admin, NEVER to the organiser or any other supplier. The organiser-facing
 * read (listForOrganiser) only ever returns AWAITING_ORGANISER or later
 * (terminal) proposals — a campaign's organiser never sees a proposal still
 * sitting in Eki's own review queue, mirroring how an organiser never sees
 * admin's internal deliberation on their own campaign submission either.
 */

const RESPONSE_WINDOW_MINUTES = 2880; // 48h — same default as the existing rescue window, for consistency.
const REMINDER_GRACE_MINUTES = 1440; // 24h after a reminder before a still-unactioned proposal expires.
const SYSTEM_CRON_ACTOR = "system:cron";

const LIVE_STATUSES = ["SUBMITTED", "ADMIN_CHANGES_NEEDED", "AWAITING_ORGANISER"] as const;
type LiveStatus = (typeof LIVE_STATUSES)[number];

export interface ProposalInput {
  proposedWholesaleAmountMinor?: number;
  proposedMaximumShares?: number;
  proposedReadyByDate?: string;
  message: string;
}

interface ResolvedSupplier {
  campaign: { id: string; status: string; fulfilmentOwner: string; maximumShares: number | null; confirmedShares: number; organiserId: string };
  supplierId: string | null;
  supplierAccountId: string | null;
  actorUserId: string;
}

async function resolveForVendor(vendorId: string, campaignId: string): Promise<ResolvedSupplier> {
  const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId }, include: { vendor: { select: { userId: true } } } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !supplier || campaign.supplierId !== supplier.id) throw new AppError("Campaign not found", 404);
  return { campaign, supplierId: supplier.id, supplierAccountId: null, actorUserId: supplier.vendor.userId };
}

async function resolveForAccount(userId: string, campaignId: string): Promise<ResolvedSupplier> {
  const account = await prisma.supplierAccount.findUnique({ where: { userId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !account || campaign.supplierAccountId !== account.id) throw new AppError("Campaign not found", 404);
  return { campaign, supplierId: null, supplierAccountId: account.id, actorUserId: userId };
}

function validateProposalInput(input: ProposalInput, campaign: { maximumShares: number | null; confirmedShares: number }): { proposedReadyByDate?: Date } {
  const { proposedWholesaleAmountMinor, proposedMaximumShares, proposedReadyByDate, message } = input;
  if (!message?.trim()) throw new AppError("A message explaining the proposed changes is required", 400);
  if (proposedWholesaleAmountMinor === undefined && proposedMaximumShares === undefined && proposedReadyByDate === undefined) {
    throw new AppError("At least one proposed change (wholesale amount, maximum shares, or ready-by date) is required", 400);
  }
  if (proposedWholesaleAmountMinor !== undefined && (!Number.isInteger(proposedWholesaleAmountMinor) || proposedWholesaleAmountMinor < 0)) {
    throw new AppError("proposedWholesaleAmountMinor must be a non-negative integer", 400);
  }
  if (proposedMaximumShares !== undefined) {
    if (!Number.isInteger(proposedMaximumShares) || proposedMaximumShares < 1) {
      throw new AppError("proposedMaximumShares must be at least 1", 400);
    }
    // A reduced-quantity request can never drop below shares already
    // confirmed by paying/pledging participants — that capacity is a real
    // commitment already made, not something a supplier's later proposal
    // can retroactively shrink out from under them.
    if (proposedMaximumShares < campaign.confirmedShares) {
      throw new AppError(`Maximum shares can't be reduced below the ${campaign.confirmedShares} already confirmed by participants`, 409, undefined, "PROPOSAL_BELOW_CONFIRMED_SHARES");
    }
  }
  let parsedReadyByDate: Date | undefined;
  if (proposedReadyByDate !== undefined) {
    parsedReadyByDate = new Date(proposedReadyByDate);
    if (Number.isNaN(parsedReadyByDate.getTime()) || parsedReadyByDate <= new Date()) {
      throw new AppError("proposedReadyByDate must be a valid future date", 400);
    }
  }
  return { proposedReadyByDate: parsedReadyByDate };
}

async function submit(resolved: ResolvedSupplier, input: ProposalInput) {
  const { campaign, supplierId, supplierAccountId, actorUserId } = resolved;
  if (campaign.fulfilmentOwner !== "SUPPLIER") {
    throw new AppError("This campaign is self-fulfilled and has no supplier to negotiate with", 409);
  }
  if (!(SUPPLIER_RESPONSE_STATUSES as readonly string[]).includes(campaign.status)) {
    throw new AppError("This campaign can no longer accept a supplier proposal", 409);
  }
  const existing = await prisma.campaignSupplierProposal.findFirst({ where: { campaignId: campaign.id, status: { in: [...LIVE_STATUSES] } } });
  if (existing) throw new AppError("A proposal is already pending for this campaign", 409, undefined, "PROPOSAL_ALREADY_PENDING");

  const { proposedReadyByDate } = validateProposalInput(input, campaign);

  const proposal = await prisma.campaignSupplierProposal.create({
    data: {
      campaignId: campaign.id,
      supplierId,
      supplierAccountId,
      submittedByUserId: actorUserId,
      proposedWholesaleAmountMinor: input.proposedWholesaleAmountMinor,
      proposedMaximumShares: input.proposedMaximumShares,
      proposedReadyByDate,
      message: input.message.trim(),
      status: "SUBMITTED",
      respondByDeadline: new Date(Date.now() + RESPONSE_WINDOW_MINUTES * 60 * 1000),
    },
  });
  await recordAudit({
    actorId: actorUserId,
    action: "community_campaign_supplier_proposal.submitted",
    entityType: "CampaignSupplierProposal",
    entityId: proposal.id,
    afterState: { status: proposal.status, proposedWholesaleAmountMinor: proposal.proposedWholesaleAmountMinor, proposedMaximumShares: proposal.proposedMaximumShares, proposedReadyByDate: proposal.proposedReadyByDate },
  });
  return proposal;
}

async function resubmit(resolved: ResolvedSupplier, proposalId: string, input: ProposalInput) {
  const existing = await prisma.campaignSupplierProposal.findUnique({ where: { id: proposalId } });
  if (!existing || existing.campaignId !== resolved.campaign.id || existing.submittedByUserId !== resolved.actorUserId) {
    throw new AppError("Proposal not found", 404);
  }
  if (existing.status !== "ADMIN_CHANGES_NEEDED") {
    throw new AppError("Only a proposal Eki has sent back for changes can be resubmitted", 409);
  }
  const { proposedReadyByDate } = validateProposalInput(input, resolved.campaign);

  const claim = await prisma.campaignSupplierProposal.updateMany({
    where: { id: proposalId, status: "ADMIN_CHANGES_NEEDED" },
    data: {
      proposedWholesaleAmountMinor: input.proposedWholesaleAmountMinor ?? null,
      proposedMaximumShares: input.proposedMaximumShares ?? null,
      proposedReadyByDate: proposedReadyByDate ?? null,
      message: input.message.trim(),
      status: "SUBMITTED",
      revisionCount: { increment: 1 },
      adminNotes: null,
      respondByDeadline: new Date(Date.now() + RESPONSE_WINDOW_MINUTES * 60 * 1000),
      remindedAt: null,
    },
  });
  if (claim.count !== 1) throw new AppError("This proposal has already moved on", 409);
  const updated = await prisma.campaignSupplierProposal.findUniqueOrThrow({ where: { id: proposalId } });
  await recordAudit({
    actorId: resolved.actorUserId,
    action: "community_campaign_supplier_proposal.resubmitted",
    entityType: "CampaignSupplierProposal",
    entityId: proposalId,
    afterState: { status: updated.status, revisionCount: updated.revisionCount },
  });
  return updated;
}

async function withdraw(resolved: ResolvedSupplier, proposalId: string) {
  const existing = await prisma.campaignSupplierProposal.findUnique({ where: { id: proposalId } });
  if (!existing || existing.campaignId !== resolved.campaign.id || existing.submittedByUserId !== resolved.actorUserId) {
    throw new AppError("Proposal not found", 404);
  }
  const claim = await prisma.campaignSupplierProposal.updateMany({
    where: { id: proposalId, status: { in: [...LIVE_STATUSES] } },
    data: { status: "WITHDRAWN" },
  });
  if (claim.count !== 1) throw new AppError("This proposal has already been decided", 409);
  await recordAudit({
    actorId: resolved.actorUserId,
    action: "community_campaign_supplier_proposal.withdrawn",
    entityType: "CampaignSupplierProposal",
    entityId: proposalId,
  });
  return prisma.campaignSupplierProposal.findUniqueOrThrow({ where: { id: proposalId } });
}

/** Supplier's own view of their proposals for one campaign — includes adminNotes (addressed to them). */
async function listMine(resolved: ResolvedSupplier) {
  return prisma.campaignSupplierProposal.findMany({ where: { campaignId: resolved.campaign.id, submittedByUserId: resolved.actorUserId }, orderBy: { createdAt: "desc" } });
}

export const campaignSupplierProposalService = {
  async submitForVendor(vendorId: string, campaignId: string, input: ProposalInput) {
    return submit(await resolveForVendor(vendorId, campaignId), input);
  },
  async submitForAccount(userId: string, campaignId: string, input: ProposalInput) {
    return submit(await resolveForAccount(userId, campaignId), input);
  },
  async resubmitForVendor(vendorId: string, campaignId: string, proposalId: string, input: ProposalInput) {
    return resubmit(await resolveForVendor(vendorId, campaignId), proposalId, input);
  },
  async resubmitForAccount(userId: string, campaignId: string, proposalId: string, input: ProposalInput) {
    return resubmit(await resolveForAccount(userId, campaignId), proposalId, input);
  },
  async withdrawForVendor(vendorId: string, campaignId: string, proposalId: string) {
    return withdraw(await resolveForVendor(vendorId, campaignId), proposalId);
  },
  async withdrawForAccount(userId: string, campaignId: string, proposalId: string) {
    return withdraw(await resolveForAccount(userId, campaignId), proposalId);
  },
  async listMineForVendor(vendorId: string, campaignId: string) {
    return listMine(await resolveForVendor(vendorId, campaignId));
  },
  async listMineForAccount(userId: string, campaignId: string) {
    return listMine(await resolveForAccount(userId, campaignId));
  },

  // ─── Organiser ──────────────────────────────────────────────────────────

  /**
   * Only ever returns AWAITING_ORGANISER or terminal proposals, and never
   * adminNotes — a proposal still sitting in Eki's own review queue
   * (SUBMITTED/ADMIN_CHANGES_NEEDED) is not this organiser's concern yet.
   */
  async listForOrganiser(userId: string, campaignId: string) {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !organiser || campaign.organiserId !== organiser.id) throw new AppError("Campaign not found", 404);
    const proposals = await prisma.campaignSupplierProposal.findMany({
      where: { campaignId, status: { in: ["AWAITING_ORGANISER", "ORGANISER_ACCEPTED", "ORGANISER_REJECTED", "EXPIRED"] } },
      orderBy: { createdAt: "desc" },
    });
    return proposals.map(({ adminNotes: _adminNotes, ...rest }) => rest);
  },

  /**
   * Applies the accepted changes to the campaign itself. Re-validates
   * proposedMaximumShares against confirmedShares AT ACCEPT TIME (not just
   * at submission time) — more pledges may have landed in between, and an
   * organiser accepting a now-stale reduced-quantity proposal must never
   * silently strand already-confirmed participants.
   */
  async accept(userId: string, proposalId: string) {
    const proposal = await prisma.campaignSupplierProposal.findUnique({
      where: { id: proposalId },
      include: { campaign: { include: { organiser: true } } },
    });
    if (!proposal) throw new AppError("Proposal not found", 404);
    if (proposal.campaign.organiser.userId !== userId) throw new AppError("Proposal not found", 404);
    if (proposal.status !== "AWAITING_ORGANISER") throw new AppError("This proposal is not awaiting your decision", 409);
    if (proposal.proposedMaximumShares != null && proposal.proposedMaximumShares < proposal.campaign.confirmedShares) {
      throw new AppError(`Maximum shares can't be reduced below the ${proposal.campaign.confirmedShares} now confirmed by participants — ask the supplier to resubmit`, 409, undefined, "PROPOSAL_STALE_BELOW_CONFIRMED_SHARES");
    }

    const claim = await prisma.campaignSupplierProposal.updateMany({
      where: { id: proposalId, status: "AWAITING_ORGANISER" },
      data: { status: "ORGANISER_ACCEPTED", organiserRespondedById: userId, organiserRespondedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("This proposal has already been decided", 409);

    await prisma.communityCampaign.update({
      where: { id: proposal.campaignId },
      data: {
        ...(proposal.proposedWholesaleAmountMinor != null && { wholesaleAmountMinor: proposal.proposedWholesaleAmountMinor }),
        ...(proposal.proposedMaximumShares != null && { maximumShares: proposal.proposedMaximumShares }),
        ...(proposal.proposedReadyByDate != null && { agreedReadyByDate: proposal.proposedReadyByDate }),
      },
    });

    await recordAudit({
      actorId: userId,
      action: "community_campaign_supplier_proposal.accepted",
      entityType: "CampaignSupplierProposal",
      entityId: proposalId,
      afterState: { proposedWholesaleAmountMinor: proposal.proposedWholesaleAmountMinor, proposedMaximumShares: proposal.proposedMaximumShares, proposedReadyByDate: proposal.proposedReadyByDate },
    });
    await notifyProposalSubmitter(proposal, "supplier_proposal_accepted", "Proposal accepted", `The organiser accepted your proposed changes for "${proposal.campaign.title}".`);
    return prisma.campaignSupplierProposal.findUniqueOrThrow({ where: { id: proposalId } });
  },

  async reject(userId: string, proposalId: string, notes?: string) {
    const proposal = await prisma.campaignSupplierProposal.findUnique({
      where: { id: proposalId },
      include: { campaign: { include: { organiser: true } } },
    });
    if (!proposal) throw new AppError("Proposal not found", 404);
    if (proposal.campaign.organiser.userId !== userId) throw new AppError("Proposal not found", 404);
    if (proposal.status !== "AWAITING_ORGANISER") throw new AppError("This proposal is not awaiting your decision", 409);

    const claim = await prisma.campaignSupplierProposal.updateMany({
      where: { id: proposalId, status: "AWAITING_ORGANISER" },
      data: { status: "ORGANISER_REJECTED", organiserRespondedById: userId, organiserRespondedAt: new Date(), organiserNotes: notes },
    });
    if (claim.count !== 1) throw new AppError("This proposal has already been decided", 409);

    await recordAudit({
      actorId: userId,
      action: "community_campaign_supplier_proposal.rejected",
      entityType: "CampaignSupplierProposal",
      entityId: proposalId,
      reason: notes,
    });
    await notifyProposalSubmitter(proposal, "supplier_proposal_rejected", "Proposal declined", `The organiser declined your proposed changes for "${proposal.campaign.title}".${notes ? ` ${notes}` : ""}`);
    return prisma.campaignSupplierProposal.findUniqueOrThrow({ where: { id: proposalId } });
  },

  // ─── Admin ──────────────────────────────────────────────────────────────

  async listForAdmin() {
    return prisma.campaignSupplierProposal.findMany({
      where: { status: "SUBMITTED" },
      include: { campaign: { select: { id: true, title: true, wholesaleAmountMinor: true, maximumShares: true, confirmedShares: true } } },
      orderBy: { createdAt: "asc" },
    });
  },

  async approveForAdmin(adminId: string, proposalId: string) {
    const proposal = await prisma.campaignSupplierProposal.findUnique({ where: { id: proposalId }, include: { campaign: { include: { organiser: true } } } });
    if (!proposal) throw new AppError("Proposal not found", 404);
    if (proposal.status !== "SUBMITTED") throw new AppError("This proposal has already been decided", 409);

    const claim = await prisma.campaignSupplierProposal.updateMany({
      where: { id: proposalId, status: "SUBMITTED" },
      data: { status: "AWAITING_ORGANISER", adminReviewedById: adminId, adminReviewedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("This proposal has already been decided", 409);

    await recordAudit({ actorId: adminId, action: "community_campaign_supplier_proposal.admin_approved", entityType: "CampaignSupplierProposal", entityId: proposalId });
    await notifyCampaign(
      proposal.campaign.organiser.userId,
      "supplier_proposal_awaiting_organiser",
      "Supplier proposed changes",
      `Your supplier has proposed changes to "${proposal.campaign.title}" — review and accept or decline.`,
      proposal.campaignId,
      `supplier_proposal_awaiting_organiser:${proposalId}`,
      "organiser",
    );
    return prisma.campaignSupplierProposal.findUniqueOrThrow({ where: { id: proposalId } });
  },

  async requestChangesForAdmin(adminId: string, proposalId: string, notes: string) {
    if (!notes?.trim()) throw new AppError("notes is required", 400);
    const proposal = await prisma.campaignSupplierProposal.findUnique({ where: { id: proposalId } });
    if (!proposal) throw new AppError("Proposal not found", 404);
    if (proposal.status !== "SUBMITTED") throw new AppError("This proposal has already been decided", 409);

    const claim = await prisma.campaignSupplierProposal.updateMany({
      where: { id: proposalId, status: "SUBMITTED" },
      data: { status: "ADMIN_CHANGES_NEEDED", adminReviewedById: adminId, adminReviewedAt: new Date(), adminNotes: notes },
    });
    if (claim.count !== 1) throw new AppError("This proposal has already been decided", 409);

    await recordAudit({ actorId: adminId, action: "community_campaign_supplier_proposal.admin_changes_needed", entityType: "CampaignSupplierProposal", entityId: proposalId, reason: notes });
    const updated = await prisma.campaignSupplierProposal.findUniqueOrThrow({ where: { id: proposalId } });
    await notifyProposalSubmitter(updated, "supplier_proposal_changes_needed", "Eki needs changes to your proposal", `Eki reviewed your proposed changes and needs adjustments before they can go to the organiser: ${notes}`);
    return updated;
  },

  // ─── Sweep (reused by the existing community-buy-sweep cron job) ────────

  /**
   * Two-stage: a first pass past respondByDeadline sends a reminder and
   * marks remindedAt (without changing status); a still-unactioned proposal
   * REMINDER_GRACE_MINUTES after that reminder finally expires. Mirrors the
   * existing privacy-expiry-sweep's own two-mechanism shape (one function,
   * one atomic claim per row) rather than inventing a new sweep pattern.
   */
  async remindAndExpireOverdue(): Promise<{ reminded: number; expired: number }> {
    let reminded = 0;
    let expired = 0;

    const needsReminder = await prisma.campaignSupplierProposal.findMany({
      where: { status: { in: [...LIVE_STATUSES] }, respondByDeadline: { lte: new Date() }, remindedAt: null },
      include: { campaign: { include: { organiser: true } } },
    });
    for (const proposal of needsReminder) {
      const claim = await prisma.campaignSupplierProposal.updateMany({
        where: { id: proposal.id, remindedAt: null },
        data: { remindedAt: new Date() },
      });
      if (claim.count !== 1) continue;
      reminded++;
      try {
        if (proposal.status === "AWAITING_ORGANISER") {
          await notifyCampaign(
            proposal.campaign.organiser.userId,
            "supplier_proposal_overdue_reminder",
            "Action needed on a supplier proposal",
            `A supplier proposal for "${proposal.campaign.title}" is still awaiting your decision.`,
            proposal.campaignId,
            `supplier_proposal_overdue_reminder:${proposal.id}`,
            "organiser",
          );
        } else {
          await notifyProposalSubmitter(proposal, "supplier_proposal_overdue_reminder", "Your proposal needs attention", `Your proposal for "${proposal.campaign.title}" hasn't moved forward yet — check its status.`);
        }
      } catch (error) {
        logger.error("Supplier proposal overdue reminder failed (non-fatal)", { proposalId: proposal.id, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }

    const needsExpiry = await prisma.campaignSupplierProposal.findMany({
      where: { status: { in: [...LIVE_STATUSES] }, remindedAt: { lte: new Date(Date.now() - REMINDER_GRACE_MINUTES * 60 * 1000) } },
    });
    for (const proposal of needsExpiry) {
      const claim = await prisma.campaignSupplierProposal.updateMany({
        where: { id: proposal.id, status: { in: [...LIVE_STATUSES] } },
        data: { status: "EXPIRED" },
      });
      if (claim.count !== 1) continue;
      expired++;
      await recordAudit({ actorId: SYSTEM_CRON_ACTOR, action: "community_campaign_supplier_proposal.expired", entityType: "CampaignSupplierProposal", entityId: proposal.id });
    }

    return { reminded, expired };
  },
};

// Resolves the real userId behind a proposal's submitter for a
// notification — submittedByUserId is already the actor's own userId
// (captured at submit time for both the legacy Vendor path, via
// supplier.vendor.userId, and the SupplierAccount path, which IS the
// userId), so no extra lookup is needed.
async function notifyProposalSubmitter(proposal: { campaignId: string; submittedByUserId: string }, event: string, title: string, body: string) {
  await notifyCampaign(proposal.submittedByUserId, event, title, body, proposal.campaignId, `${event}:${proposal.campaignId}:${proposal.submittedByUserId}`).catch((error) => {
    logger.error("Supplier proposal notification failed (non-fatal)", { event, errorMessage: error instanceof Error ? error.message : String(error) });
  });
}
