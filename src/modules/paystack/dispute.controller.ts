import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { disputeService } from "./dispute.service";

/**
 * POST /api/orders/:id/dispute
 * Buyer opens a dispute on a DISPATCHED escrow order.
 */
export async function openDispute(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);

  const { reason } = request.body as Record<string, unknown>;
  if (typeof reason !== "string" || !reason.trim()) {
    throw new AppError("reason is required", 400);
  }

  const result = await disputeService.openDispute(request.user.id, orderId, reason);
  response.status(201).json(result);
}

/**
 * GET /api/admin/disputes
 * Admin lists disputes.
 */
export async function adminListDisputes(request: Request, response: Response): Promise<void> {
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100);
  const cursor = typeof request.query.cursor === "string" ? request.query.cursor : undefined;

  const result = await disputeService.listDisputes({ status, limit, cursor });
  response.status(200).json(result);
}

/**
 * GET /api/admin/disputes/:id
 * Admin gets dispute detail.
 */
export async function adminGetDispute(request: Request, response: Response): Promise<void> {
  const disputeId = String(request.params.id ?? "");
  if (!disputeId) throw new AppError("Dispute ID required", 400);

  const dispute = await disputeService.getDispute(disputeId);
  response.status(200).json({ dispute });
}

/**
 * PATCH /api/admin/disputes/:id/resolve
 * Admin resolves a dispute.
 */
export async function adminResolveDispute(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const disputeId = String(request.params.id ?? "");
  if (!disputeId) throw new AppError("Dispute ID required", 400);

  const { resolution, note, refundAmount, fraudulent } = request.body as Record<string, unknown>;

  if (!["vendor", "buyer", "partial"].includes(resolution as string)) {
    throw new AppError("resolution must be vendor, buyer, or partial", 400);
  }
  if (typeof note !== "string" || !note.trim()) {
    throw new AppError("note is required", 400);
  }

  const result = await disputeService.resolveDispute(disputeId, request.user.id, {
    resolution: resolution as "vendor" | "buyer" | "partial",
    note: note.trim(),
    refundAmount: typeof refundAmount === "number" ? refundAmount : undefined,
    fraudulent: fraudulent === true,
  });

  response.status(200).json(result);
}
