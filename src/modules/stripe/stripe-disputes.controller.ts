import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { stripeDisputesService } from "./stripe-disputes.service";

/**
 * GET /api/admin/stripe-disputes
 * Admin lists real Stripe chargebacks (architecture doc §15.3 "Chargebacks").
 */
export async function adminListStripeDisputes(request: Request, response: Response): Promise<void> {
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const limit = Number(request.query.limit) || 100;
  const items = await stripeDisputesService.list(status, limit);
  response.status(200).json({ items });
}

/**
 * PATCH /api/admin/stripe-disputes/:id/review
 * Admin marks a chargeback as reviewed, with a note.
 */
export async function adminReviewStripeDispute(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const id = String(request.params.id ?? "");
  if (!id) throw new AppError("Stripe dispute ID required", 400);
  const { note } = request.body as Record<string, unknown>;
  if (typeof note !== "string" || !note.trim()) {
    throw new AppError("note is required", 400);
  }
  const dispute = await stripeDisputesService.markReviewed(id, note.trim());
  await recordAudit({
    actorId: request.user.id,
    action: "stripe_dispute.reviewed",
    entityType: "StripeDispute",
    entityId: id,
    reason: note.trim(),
    request,
  });
  response.status(200).json({ dispute });
}
