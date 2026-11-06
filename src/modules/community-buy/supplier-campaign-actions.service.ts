import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notifyUserInAppAndEmail } from "./community-buy-notices";
import { marketConfigurationService } from "./market-configuration.service";

export const INVENTORY_STATUSES = ["CONFIRMED", "LIMITED", "NO_LONGER_AVAILABLE"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

const SUCCESSFUL_STATUSES = ["SUCCEEDED", "FULFILLING", "COMPLETED", "FINANCIALLY_CLOSED"] as const;
const COMPLETED_CONTRIBUTIONS = ["PAID", "REFUND_PENDING", "REFUND_PROCESSING", "REFUNDED", "REFUND_FAILED"];
const FAILED_CONTRIBUTIONS = ["PAYMENT_FAILED", "CHARGE_FAILED"];

/** Only the supplier on this campaign can answer for it, whichever kind of account they supply through. */
async function requireSupplierOnCampaign(userId: string, campaignId: string) {
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      title: true,
      organiser: { select: { userId: true } },
      supplierAccount: { select: { userId: true } },
      supplier: { select: { vendor: { select: { userId: true } } } },
    },
  });
  const isSupplier = campaign && (campaign.supplierAccount?.userId === userId || campaign.supplier?.vendor?.userId === userId);
  if (!campaign || !isSupplier) throw new AppError("Campaign not found", 404);
  return campaign;
}

export const supplierCampaignActionsService = {
  /** CB69. Telling the organiser straight away is the point: they may need to find more stock. */
  async setInventoryStatus(userId: string, campaignId: string, rawStatus: unknown) {
    if (!INVENTORY_STATUSES.includes(rawStatus as InventoryStatus)) {
      throw new AppError("Choose an inventory status", 400, undefined, "INVALID_INVENTORY_STATUS");
    }
    const status = rawStatus as InventoryStatus;
    const campaign = await requireSupplierOnCampaign(userId, campaignId);
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { supplierInventoryStatus: status, supplierInventoryStatusAt: new Date() },
      select: { id: true, supplierInventoryStatus: true, supplierInventoryStatusAt: true },
    });
    await recordAudit({ actorId: userId, action: "community_campaign.inventory_status", entityType: "CommunityCampaign", entityId: campaignId, afterState: { status } });
    if (status !== "CONFIRMED") {
      await notifyUserInAppAndEmail({
        userId: campaign.organiser.userId,
        title: status === "LIMITED" ? "Stock is limited" : "Stock is no longer available",
        body: status === "LIMITED"
          ? `The supplier says stock for ${campaign.title} is limited.`
          : `The supplier says stock for ${campaign.title} is no longer available. Please contact support.`,
        event: "supplier_inventory_status",
        data: { campaignId, status },
      });
    }
    return updated;
  },

  /** CB67: goes to the support queue, so the supplier gets an answer from the same place as any other case. */
  async askQuestion(userId: string, campaignId: string, rawQuestion: unknown) {
    const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";
    if (!question) throw new AppError("Write your question", 400, undefined, "QUESTION_REQUIRED");
    if (question.length > 2000) throw new AppError("Keep your question under 2000 characters", 400, undefined, "QUESTION_TOO_LONG");
    await requireSupplierOnCampaign(userId, campaignId);
    const supportCase = await prisma.communityBuySupportCase.create({
      data: { campaignId, participantId: userId, caseType: "OTHER", description: `Supplier question: ${question}` },
      select: { id: true, status: true, createdAt: true },
    });
    return supportCase;
  },

  /** CB65. Demo-only numbers can't leak in: this only ever counts the organiser's own campaigns. */
  async organiserHistory(userId: string) {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId }, select: { id: true, country: true } });
    if (!organiser) {
      return { campaignsOrganised: 0, successfulCampaigns: 0, participantCompletionRate: null, fulfilmentIssues: 0, organiserPaymentsEnabled: false };
    }
    const mine = { organiserId: organiser.id };
    const [campaignsOrganised, successfulCampaigns, completed, failed, fulfilmentIssues, market] = await Promise.all([
      prisma.communityCampaign.count({ where: { ...mine, status: { notIn: ["DRAFT", "CHANGES_REQUIRED"] } } }),
      prisma.communityCampaign.count({ where: { ...mine, status: { in: [...SUCCESSFUL_STATUSES] } } }),
      prisma.campaignContribution.count({ where: { status: { in: COMPLETED_CONTRIBUTIONS as never[] }, participant: { campaign: mine } } }),
      prisma.campaignContribution.count({ where: { status: { in: FAILED_CONTRIBUTIONS as never[] }, participant: { campaign: mine } } }),
      prisma.communityBuySupportCase.count({ where: { caseType: "FULFILMENT_ISSUE", campaign: mine } }),
      marketConfigurationService.get(organiser.country).catch(() => null),
    ]);
    const attempted = completed + failed;
    return {
      campaignsOrganised,
      successfulCampaigns,
      participantCompletionRate: attempted > 0 ? Math.round((completed / attempted) * 100) : null,
      fulfilmentIssues,
      organiserPaymentsEnabled: !!market?.organiserFeeBps && market.organiserFeeEnabled !== false,
    };
  },
};
