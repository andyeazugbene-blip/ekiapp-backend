import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { trustScoreService } from "./trust-score.service";

/**
 * PATCH /api/admin/users/:id/trust-score
 * Admin manually adjusts a user's trust score.
 */
export async function adminAdjustTrustScore(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const userId = String(request.params.id ?? "");
  if (!userId) throw new AppError("User ID required", 400);

  const { adjustment, reason } = request.body as Record<string, unknown>;
  if (typeof adjustment !== "number" || !Number.isInteger(adjustment)) {
    throw new AppError("adjustment must be an integer (positive or negative)", 400);
  }
  if (Math.abs(adjustment) > 50) {
    throw new AppError("adjustment cannot exceed ±50", 400);
  }

  // Handbook 2.1: every admin mutation carries a server-validated reason.
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < 5) {
    throw new AppError("A reason of at least 5 characters is required", 400);
  }

  const result = await trustScoreService.adminAdjustTrustScore(userId, adjustment, request.user.id, cleanReason);
  response.status(200).json(result);
}
