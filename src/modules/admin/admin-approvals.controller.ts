import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminApprovalsService } from "./admin-approvals.service";
import { campaignContributionsService } from "../community-buy/campaign-contributions.service";
import { executeOrderRefund } from "./admin-refunds.controller";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function adminListPendingApprovals(_request: Request, response: Response): Promise<void> {
  response.json({ items: await adminApprovalsService.listPending() });
}

/**
 * Decide a pending four-eyes approval. On APPROVE, this is also the single
 * place that actually executes the gated action — the original action's
 * endpoint (e.g. supplier payment release) only ever creates the pending
 * request when gated, never performs the action itself. Each actionType
 * this framework gates needs its execution wired in here explicitly; an
 * actionType with a rule but no case below fails closed with a clear error
 * rather than silently approving without doing anything.
 *
 * Validate -> execute -> commit, in that order: the approval is only
 * durably marked APPROVED once the gated action has actually succeeded.
 * A provider failure (Stripe down, a network blip) during execution used
 * to still mark the approval APPROVED (the write happened before the
 * execution attempt) — permanently stranding it with nothing executed,
 * no way to retry through this endpoint, and no audit trail of what
 * happened. Now a failed execution leaves the approval PENDING (retryable
 * by any qualified admin once the underlying problem clears) and still
 * writes an immutable audit record of the failed attempt.
 */
export async function adminDecideApproval(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Missing approval id", 400);
  const { approve, note } = request.body ?? {};
  if (typeof approve !== "boolean") throw new AppError("approve (boolean) is required", 400);
  const decisionNote = typeof note === "string" ? note : undefined;

  if (!approve) {
    const approval = await adminApprovalsService.decide(id, adminId, false, decisionNote);
    await recordAudit({
      actorId: adminId,
      action: "admin_approval.rejected",
      entityType: approval.businessRefType,
      entityId: approval.businessRefId,
      metadata: { approvalId: id, actionType: approval.actionType, note: note ?? null },
    });
    response.json({ approval });
    return;
  }

  const approval = await adminApprovalsService.validateDecision(id, adminId);

  try {
    if (approval.actionType === "community_buy.supplier_payment_release") {
      await campaignContributionsService.releaseSupplierPayment(adminId, approval.businessRefId);
    } else if (approval.actionType === "order.refund.large") {
      await executeOrderRefund(approval.businessRefId, adminId, approval.amount ?? undefined, "Four-eyes approved refund");
    } else {
      throw new AppError(`No execution wired for approved actionType "${approval.actionType}"`, 500, undefined, "APPROVAL_EXECUTION_NOT_WIRED");
    }
  } catch (error) {
    await recordAudit({
      actorId: adminId,
      action: "admin_approval.execution_failed",
      entityType: approval.businessRefType,
      entityId: approval.businessRefId,
      metadata: {
        approvalId: id,
        actionType: approval.actionType,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }

  const decided = await adminApprovalsService.commitDecision(id, adminId, true, decisionNote);

  await recordAudit({
    actorId: adminId,
    action: "admin_approval.approved_and_executed",
    entityType: decided.businessRefType,
    entityId: decided.businessRefId,
    metadata: { approvalId: id, actionType: decided.actionType, note: note ?? null },
  });

  response.json({ approval: decided });
}

export async function adminListApprovalRules(_request: Request, response: Response): Promise<void> {
  response.json({ items: await adminApprovalsService.listRules() });
}

export async function adminUpsertApprovalRule(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const actionType = request.params.actionType;
  if (typeof actionType !== "string" || actionType.length === 0) throw new AppError("Missing actionType", 400);
  const { thresholdAmount, currency, enabled } = request.body ?? {};
  const rule = await adminApprovalsService.upsertRule(actionType, {
    thresholdAmount: thresholdAmount === null || thresholdAmount === undefined ? null : Number(thresholdAmount),
    currency: currency ?? null,
    enabled: enabled === undefined ? undefined : Boolean(enabled),
  });
  await recordAudit({ actorId: adminId, action: "admin_approval_rule.upsert", entityType: "AdminApprovalRule", entityId: actionType, metadata: { thresholdAmount, currency, enabled } });
  response.json({ rule });
}
