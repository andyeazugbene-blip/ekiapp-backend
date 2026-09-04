import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { reconciliationService } from "./reconciliation.service";
import { paymentAnomalyService } from "./payment-anomaly.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

/** Real balances computed directly from LedgerAccount/LedgerEntry — never a separate aggregate. */
export async function adminGetLedgerBalances(_request: Request, response: Response): Promise<void> {
  response.json({ items: await reconciliationService.getBalances() });
}

export async function adminListReconciliationRuns(_request: Request, response: Response): Promise<void> {
  response.json({ items: await reconciliationService.listRuns() });
}

export async function adminGetReconciliationRun(request: Request, response: Response): Promise<void> {
  response.json({ run: await reconciliationService.getRun(requireIdParam(request)) });
}

export async function adminListOpenDifferences(_request: Request, response: Response): Promise<void> {
  response.json({ items: await reconciliationService.listOpenDifferences() });
}

export async function adminRunReconciliation(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const provider = request.body?.provider;
  if (provider !== "stripe" && provider !== "paystack") throw new AppError("provider must be \"stripe\" or \"paystack\"", 400);
  const periodStart = new Date(request.body?.periodStart);
  const periodEnd = new Date(request.body?.periodEnd);
  const run = await reconciliationService.runReconciliation(provider, periodStart, periodEnd);
  await recordAudit({
    actorId: adminId,
    action: "reconciliation_run.execute",
    entityType: "ReconciliationRun",
    entityId: run.id,
    metadata: { provider, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), differenceCount: run.differences.length, status: run.status },
  });
  response.status(201).json({ run });
}

export async function adminResolveReconciliationDifference(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const note = request.body?.note;
  if (typeof note !== "string" || !note.trim()) throw new AppError("note is required", 400);
  const id = requireIdParam(request);
  const difference = await reconciliationService.resolveDifference(id, note);
  await recordAudit({ actorId: adminId, action: "reconciliation_difference.resolve", entityType: "ReconciliationDifference", entityId: id, reason: note, request });
  response.json({ difference });
}

// ─── Payment anomaly / duplicate-payment queue (architecture doc §15.3) ───

export async function adminScanPaymentAnomalies(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const result = await paymentAnomalyService.scan();
  await recordAudit({ actorId: adminId, action: "payment_anomaly.scan", entityType: "PaymentAnomaly", metadata: { found: result.found }, request });
  response.json(result);
}

export async function adminListPaymentAnomalies(request: Request, response: Response): Promise<void> {
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  response.json({ items: await paymentAnomalyService.list(status) });
}

export async function adminReviewPaymentAnomaly(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const note = request.body?.note;
  if (typeof note !== "string" || !note.trim()) throw new AppError("note is required", 400);
  const anomaly = await paymentAnomalyService.markReviewed(requireIdParam(request), adminId, note.trim());
  await recordAudit({ actorId: adminId, action: "payment_anomaly.reviewed", entityType: "PaymentAnomaly", entityId: anomaly.id, reason: note, request });
  response.json({ anomaly });
}

export async function adminEscalatePaymentAnomaly(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const note = request.body?.note;
  if (typeof note !== "string" || !note.trim()) throw new AppError("note is required", 400);
  const anomaly = await paymentAnomalyService.escalate(requireIdParam(request), adminId, note.trim());
  await recordAudit({ actorId: adminId, action: "payment_anomaly.escalated", entityType: "PaymentAnomaly", entityId: anomaly.id, reason: note, request });
  response.json({ anomaly });
}
