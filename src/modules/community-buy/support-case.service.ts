import type { SupportCaseStatus, SupportCaseType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/**
 * Community Buy support cases — doc Phase 9. Distinct from ContentReport
 * (content moderation) and Dispute (tied 1:1 to an Order, which a
 * campaign contribution isn't). See schema.prisma for why this needed a
 * new model rather than reusing either.
 */

async function requireRealRelationshipToCampaign(userId: string, campaignId: string): Promise<void> {
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id: campaignId },
    include: { organiser: true, supplier: { include: { vendor: true } } },
  });
  if (!campaign) throw new AppError("Campaign not found", 404);

  if (campaign.organiser.userId === userId) return;
  if (campaign.supplier.vendor.userId === userId) return;
  const participant = await prisma.campaignParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId } } });
  if (participant) return;

  throw new AppError("You don't have a relationship to this campaign", 403);
}

// Fields a non-admin reporter is allowed to see on their own case —
// internalNotes is deliberately excluded everywhere outside admin reads.
function toCustomerSafeCase<T extends { internalNotes: string | null }>(supportCase: T): Omit<T, "internalNotes"> {
  const { internalNotes, ...rest } = supportCase;
  return rest;
}

export const supportCaseService = {
  async create(userId: string, campaignId: string, input: { caseType: SupportCaseType; description: string; evidenceUrls?: string[] }) {
    if (!input.description?.trim()) throw new AppError("description is required", 400);
    await requireRealRelationshipToCampaign(userId, campaignId);

    const supportCase = await prisma.communityBuySupportCase.create({
      data: {
        campaignId,
        participantId: userId,
        caseType: input.caseType,
        description: input.description.trim(),
        evidenceUrls: input.evidenceUrls ?? [],
      },
    });
    return toCustomerSafeCase(supportCase);
  },

  async listMine(userId: string) {
    const cases = await prisma.communityBuySupportCase.findMany({
      where: { participantId: userId },
      include: { campaign: { select: { id: true, title: true } } },
      orderBy: { createdAt: "desc" },
    });
    return cases.map(toCustomerSafeCase);
  },

  async getMine(userId: string, caseId: string) {
    const supportCase = await prisma.communityBuySupportCase.findUnique({
      where: { id: caseId },
      include: { campaign: { select: { id: true, title: true } } },
    });
    if (!supportCase || supportCase.participantId !== userId) throw new AppError("Support case not found", 404);
    return toCustomerSafeCase(supportCase);
  },

  // ─── Admin ──────────────────────────────────────────────────────────────

  async listForAdmin(status?: SupportCaseStatus) {
    return prisma.communityBuySupportCase.findMany({
      where: status ? { status } : undefined,
      include: {
        campaign: { select: { id: true, title: true } },
        participant: { select: { name: true, email: true } },
      },
      orderBy: [{ escalated: "desc" }, { createdAt: "desc" }],
    });
  },

  async getForAdmin(caseId: string) {
    const supportCase = await prisma.communityBuySupportCase.findUnique({
      where: { id: caseId },
      include: {
        campaign: { select: { id: true, title: true } },
        participant: { select: { name: true, email: true } },
      },
    });
    if (!supportCase) throw new AppError("Support case not found", 404);
    return supportCase;
  },

  async adminUpdate(adminId: string, caseId: string, input: Partial<{
    status: SupportCaseStatus;
    internalNotes: string;
    customerVisibleResponse: string;
    escalated: boolean;
  }>) {
    const existing = await prisma.communityBuySupportCase.findUnique({ where: { id: caseId } });
    if (!existing) throw new AppError("Support case not found", 404);

    const data: Record<string, unknown> = {};
    if (input.status !== undefined) {
      data.status = input.status;
      if (input.status === "RESOLVED" || input.status === "CLOSED") {
        data.resolvedById = adminId;
        data.resolvedAt = new Date();
      }
    }
    if (input.internalNotes !== undefined) data.internalNotes = input.internalNotes;
    if (input.customerVisibleResponse !== undefined) data.customerVisibleResponse = input.customerVisibleResponse;
    if (input.escalated !== undefined) {
      data.escalated = input.escalated;
      if (input.escalated) data.escalatedAt = new Date();
    }

    return prisma.communityBuySupportCase.update({ where: { id: caseId }, data });
  },
};
