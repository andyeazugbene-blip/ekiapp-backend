import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { vendorAnalyticsService } from "./vendors-analytics.service";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function getVendorAnalytics(request: Request, response: Response): Promise<void> {
  const analytics = await vendorAnalyticsService.getAnalytics(requireUserId(request), request.query.range);
  response.status(200).json({ analytics });
}
