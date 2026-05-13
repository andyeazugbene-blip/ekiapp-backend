import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { vendorDashboardService } from "./vendors-dashboard.service";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function getVendorDashboard(request: Request, response: Response): Promise<void> {
  const data = await vendorDashboardService.getDashboard(requireUserId(request));
  response.status(200).json(data);
}

export async function getVendorEarnings(request: Request, response: Response): Promise<void> {
  const data = await vendorDashboardService.getEarnings(requireUserId(request));
  response.status(200).json(data);
}
