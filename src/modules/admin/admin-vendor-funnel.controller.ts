import type { Request, Response } from "express";

import { adminVendorFunnelService } from "./admin-vendor-funnel.service";

export async function getVendorOnboardingFunnel(request: Request, response: Response): Promise<void> {
  response.json(await adminVendorFunnelService.getFunnel(request.query.range, request.query.from, request.query.to));
}
