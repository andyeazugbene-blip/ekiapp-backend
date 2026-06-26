import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { adminAnalyticsService } from "./admin-analytics.service";

const VALID_RANGES = new Set(["7d", "30d", "90d"]);

export async function getAnalyticsOverview(_req: Request, res: Response): Promise<void> {
  const data = await adminAnalyticsService.getOverview();
  res.json(data);
}

export async function getAnalyticsGrowth(req: Request, res: Response): Promise<void> {
  if (req.query.range !== undefined && typeof req.query.range === "string" && !VALID_RANGES.has(req.query.range)) {
    throw new AppError("range must be 7d, 30d, or 90d", 400);
  }
  const range = (typeof req.query.range === "string" && VALID_RANGES.has(req.query.range)
    ? req.query.range
    : "30d") as "7d" | "30d" | "90d";
  const data = await adminAnalyticsService.getGrowth(range);
  res.json(data);
}
