import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import {
  getBuyerAnalytics,
  getOrderAnalytics,
  getVendorAnalytics,
} from "./admin-analytics-phase2.service";

const VALID_RANGES = new Set(["7d", "30d", "90d"]);

function validateRange(raw: unknown): void {
  if (raw !== undefined && typeof raw === "string" && !VALID_RANGES.has(raw)) {
    throw new AppError("range must be 7d, 30d, or 90d", 400);
  }
}

export async function getAnalyticsBuyers(req: Request, res: Response): Promise<void> {
  validateRange(req.query.range);
  const data = await getBuyerAnalytics(req.query.range);
  res.json(data);
}

export async function getAnalyticsVendors(req: Request, res: Response): Promise<void> {
  validateRange(req.query.range);
  const data = await getVendorAnalytics(req.query.range);
  res.json(data);
}

export async function getAnalyticsOrders(req: Request, res: Response): Promise<void> {
  validateRange(req.query.range);
  const data = await getOrderAnalytics(req.query.range);
  res.json(data);
}
