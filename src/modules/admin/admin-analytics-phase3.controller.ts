import { Request, Response } from "express";

import { getGeographicAnalytics, getPaymentAnalytics } from "./admin-analytics-phase3.service";

export async function getAnalyticsPayments(req: Request, res: Response) {
  const data = await getPaymentAnalytics(req.query.range);
  res.json(data);
}

export async function getAnalyticsGeography(req: Request, res: Response) {
  const data = await getGeographicAnalytics(req.query.range);
  res.json(data);
}
