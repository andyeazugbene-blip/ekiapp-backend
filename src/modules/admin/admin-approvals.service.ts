import { AdminApprovalStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/**
 * Generic second-admin ("four-eyes") approval workflow (architecture doc §7).
 *
 * The threshold that decides whether an action type requires approval is
 * configurable per actionType via AdminApprovalRule — never hardcoded here.
 * With no rule row for an actionType, requiresApproval() defaults to false
 * (the action proceeds as it always has) so adding this framework can never
 * silently block an action nobody has opted in to gating yet.
 */
export const adminApprovalsService = {
  async requiresApproval(actionType: string, amount?: number | null): Promise<boolean> {
    const rule = await prisma.adminApprovalRule.findUnique({ where: { actionType } });
    if (!rule || !rule.enabled) return false;
    if (rule.thresholdAmount == null) return true; // always requires approval regardless of amount
    if (amount == null) return true; // rule has an amount threshold but caller didn't supply one — fail safe to "requires approval"
    return amount >= rule.thresholdAmount;
  },

  async requestApproval(params: {
    actionType: string;
    businessRefType: string;
    businessRefId: string;
    amount?: number | null;
    currency?: string | null;
    requestedById: string;
    reason: string;
  }) {
    const existing = await prisma.adminApproval.findFirst({
      where: { actionType: params.actionType, businessRefType: params.businessRefType, businessRefId: params.businessRefId, status: AdminApprovalStatus.PENDING },
    });
    if (existing) return existing; // idempotent — don't create a second pending request for the same action

    return prisma.adminApproval.create({
      data: {
        actionType: params.actionType,
        businessRefType: params.businessRefType,
        businessRefId: params.businessRefId,
        amount: params.amount ?? null,
        currency: params.currency ?? null,
        requestedById: params.requestedById,
        reason: params.reason,
      },
    });
  },

  async listPending() {
    return prisma.adminApproval.findMany({
      where: { status: AdminApprovalStatus.PENDING },
      include: { requestedBy: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
  },

  /** Returns the decided approval. Throws if the deciding admin is the same as the requester — that's the entire point of four-eyes. */
  async decide(approvalId: string, decidedById: string, approve: boolean, note?: string) {
    const approval = await prisma.adminApproval.findUnique({ where: { id: approvalId } });
    if (!approval) throw new AppError("Approval request not found", 404);
    if (approval.status !== AdminApprovalStatus.PENDING) throw new AppError("This approval has already been decided", 409);
    if (approval.requestedById === decidedById) {
      throw new AppError("A second, different admin must decide this — the requester cannot approve their own request", 403, undefined, "SELF_APPROVAL_FORBIDDEN");
    }

    return prisma.adminApproval.update({
      where: { id: approvalId },
      data: {
        status: approve ? AdminApprovalStatus.APPROVED : AdminApprovalStatus.REJECTED,
        decidedById,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });
  },

  async cancel(approvalId: string) {
    await prisma.adminApproval.updateMany({
      where: { id: approvalId, status: AdminApprovalStatus.PENDING },
      data: { status: AdminApprovalStatus.CANCELLED },
    });
  },

  // ─── Rule management (read/write the configurable threshold) ───────────

  async listRules() {
    return prisma.adminApprovalRule.findMany({ orderBy: { actionType: "asc" } });
  },

  async upsertRule(actionType: string, input: { thresholdAmount?: number | null; currency?: string | null; enabled?: boolean }) {
    return prisma.adminApprovalRule.upsert({
      where: { actionType },
      create: { actionType, thresholdAmount: input.thresholdAmount ?? null, currency: input.currency ?? null, enabled: input.enabled ?? true },
      update: { thresholdAmount: input.thresholdAmount, currency: input.currency, enabled: input.enabled },
    });
  },
};
