import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const AT_RISK_WINDOW_MS = 48 * 3_600_000;
const FAILED = ["PAYMENT_FAILED", "CHARGE_FAILED"] as const;

export type CampaignRisk = "Normal" | "At risk" | "Needs attention" | "Paused";

/** CB79's risk status, from what's known about the campaign right now. */
export function campaignRisk(input: { status: string; deadline: Date | null; confirmedShares: number; minimumShares: number | null; failedPayments: number }, now = new Date()): CampaignRisk {
  if (input.status === "PAUSED") return "Paused";
  if (input.status === "RESCUE_WINDOW" || input.status === "DECISION_REQUIRED" || input.failedPayments > 0) return "Needs attention";
  const closing = input.deadline && input.deadline.getTime() - now.getTime() < AT_RISK_WINDOW_MS;
  if (input.status === "LIVE" && closing && input.confirmedShares < (input.minimumShares ?? 0)) return "At risk";
  return "Normal";
}

const realCampaign = { organiser: { user: { isTest: false } } };

export const campaignOperationsService = {
  /** CB77's tiles. Demo campaigns aren't counted. */
  async summary(now = new Date()) {
    const closingBy = new Date(now.getTime() + AT_RISK_WINDOW_MS);
    const [awaitingReview, atRiskRows, completionPeriods, paymentExceptions, refundsNeedingAttention, fulfilmentIssues] = await Promise.all([
      prisma.communityCampaign.count({ where: { status: "UNDER_REVIEW", ...realCampaign } }),
      prisma.communityCampaign.findMany({ where: { status: "LIVE", deadline: { lte: closingBy }, ...realCampaign }, select: { confirmedShares: true, minimumShares: true } }),
      prisma.communityCampaign.count({ where: { status: "RESCUE_WINDOW", ...realCampaign } }),
      prisma.campaignContribution.count({ where: { status: { in: [...FAILED] }, participant: { campaign: { status: { in: ["LIVE", "RESCUE_WINDOW", "FULFILLING"] }, ...realCampaign } } } }),
      prisma.campaignRefund.count({ where: { status: "REFUND_FAILED" } }),
      prisma.communityBuySupportCase.count({ where: { caseType: "FULFILMENT_ISSUE", status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED"] } } }),
    ]);
    return {
      awaitingReview,
      liveAtRisk: atRiskRows.filter((c) => c.confirmedShares < (c.minimumShares ?? 0)).length,
      completionPeriods,
      paymentExceptions,
      refundsNeedingAttention,
      fulfilmentIssues,
    };
  },

  /** CB79 and CB80: what's confirmed, what's processing, and what the outcome rule says. */
  async monitoring(campaignId: string, now = new Date()) {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, deadline: true, confirmedShares: true, minimumShares: true, goalShares: true, maximumShares: true },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);
    const groups = await prisma.campaignContribution.groupBy({
      by: ["status"],
      where: { participant: { campaignId } },
      _sum: { quantity: true },
      _count: { _all: true },
    });
    const count = (statuses: readonly string[]) => groups.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + g._count._all, 0);
    const shares = (statuses: readonly string[]) => groups.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + (g._sum.quantity ?? 0), 0);
    const confirmedPayments = count(["PAID"]);
    const processingPayments = count(["PAYMENT_PROCESSING"]);
    const failedPayments = count(FAILED);
    const confirmedShares = shares(["PAID"]);
    const processingShares = shares(["PAYMENT_PROCESSING"]);
    const deadlineReached = !!campaign.deadline && campaign.deadline <= now;
    const minimum = campaign.minimumShares ?? 0;
    return {
      ...campaign,
      confirmedPayments,
      processingPayments,
      failedPayments,
      paidShares: confirmedShares,
      processingShares,
      risk: campaignRisk({ ...campaign, failedPayments }, now),
      // CB80: only provider-confirmed contributions count towards the final quantity.
      suggestedOutcome: !deadlineReached
        ? null
        : processingShares > 0
          ? "Wait for processing payments"
          : confirmedShares >= minimum && minimum > 0
            ? "Proceed at confirmed quantity"
            : campaign.status === "RESCUE_WINDOW"
              ? "Fail campaign"
              : "Open completion period",
    };
  },
};
