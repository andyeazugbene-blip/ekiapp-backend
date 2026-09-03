import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminApprovalsService } from "./admin-approvals.service";
import { campaignContributionsService } from "../community-buy/campaign-contributions.service";

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
 */
export async function adminDecideApproval(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Missing approval id", 400);
  const { approve, note } = request.body ?? {};
  if (typeof approve !== "boolean") throw new AppError("approve (boolean) is required", 400);

  const approval = await adminApprovalsService.decide(id, adminId, approve, typeof note === "string" ? note : undefined);

  if (approve) {
    if (approval.actionType === "community_buy.supplier_payment_release") {
      await campaignContributionsService.releaseSupplierPayment(adminId, approval.businessRefId);
    } else {
      throw new AppError(`No execution wired for approved actionType "${approval.actionType}"`, 500, undefined, "APPROVAL_EXECUTION_NOT_WIRED");
    }
  }

  await recordAudit({
    actorId: adminId,
    action: approve ? "admin_approval.approved_and_executed" : "admin_approval.rejected",
    entityType: approval.businessRefType,
    entityId: approval.businessRefId,
    metadata: { approvalId: id, actionType: approval.actionType, note: note ?? null },
  });

  response.json({ approval });
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
