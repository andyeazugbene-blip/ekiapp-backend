import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { referralsService } from "./referrals.service";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function getReferralInfo(request: Request, response: Response): Promise<void> {
  const stats = await referralsService.getReferralStats(requireUserId(request));
  response.status(200).json(stats);
}
