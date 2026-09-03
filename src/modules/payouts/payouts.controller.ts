import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { payoutsService } from "./payouts.service";
import {
  validateCreatePayoutRequestInput,
  validateListPayoutRequestsQuery,
  validateRejectPayoutRequestInput,
} from "./payouts.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

export async function createPayoutRequest(request: Request, response: Response): Promise<void> {
  const input = validateCreatePayoutRequestInput(request.body);
  const payoutRequest = await payoutsService.createRequest(requireUserId(request), input);
  response.status(201).json({ payoutRequest });
}

export async function listOwnPayoutRequests(request: Request, response: Response): Promise<void> {
  const payoutRequests = await payoutsService.listOwn(requireUserId(request));
  response.status(200).json({ payoutRequests });
}

export async function adminListPayoutRequests(
  request: Request,
  response: Response,
): Promise<void> {
  const query = validateListPayoutRequestsQuery(request.query as Record<string, unknown>);
  const payoutRequests = await payoutsService.adminList(query);
  response.status(200).json({ payoutRequests });
}

export async function adminApprovePayoutRequest(
  request: Request,
  response: Response,
): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const payoutRequest = await payoutsService.adminApprove(adminId, id);
  await recordAudit({ actorId: adminId, action: "payout_request.approve", entityType: "PayoutRequest", entityId: id, metadata: { amount: payoutRequest.amount, vendorId: payoutRequest.vendorId } });
  response.status(200).json({ payoutRequest });
}

export async function adminRejectPayoutRequest(
  request: Request,
  response: Response,
): Promise<void> {
  const input = validateRejectPayoutRequestInput(request.body);
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const payoutRequest = await payoutsService.adminReject(adminId, id, input);
  await recordAudit({ actorId: adminId, action: "payout_request.reject", entityType: "PayoutRequest", entityId: id, metadata: { reason: input.reason } });
  response.status(200).json({ payoutRequest });
}

export async function adminMarkPayoutRequestPaid(
  request: Request,
  response: Response,
): Promise<void> {
  const body = request.body || {};
  const transferProof = typeof body.transferProof === "string" ? body.transferProof.trim() : undefined;
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const payoutRequest = await payoutsService.adminMarkPaid(adminId, id, transferProof);
  await recordAudit({ actorId: adminId, action: "payout_request.mark_paid", entityType: "PayoutRequest", entityId: id, metadata: { amount: payoutRequest.amount, vendorId: payoutRequest.vendorId, hasTransferProof: Boolean(transferProof) } });
  response.status(200).json({ payoutRequest });
}
export async function adminGetPayoutRequest(
  request: Request,
  response: Response,
): Promise<void> {
  const payoutRequest = await payoutsService.adminGet(requireIdParam(request));
  response.status(200).json({ payoutRequest });
}

export async function listOwnPayoutRequestsWithDetails(
  request: Request,
  response: Response,
): Promise<void> {
  const payoutRequests = await payoutsService.listOwnWithDetails(requireUserId(request));
  response.status(200).json({ payoutRequests });
}
