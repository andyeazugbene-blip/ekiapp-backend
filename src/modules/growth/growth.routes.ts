import { Router, type Request, type Response } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { AppError } from "../../shared/errors/app-error";
import { requireAuditReason } from "../../shared/utils/audit";
import { asyncHandler } from "../../shared/utils/async-handler";
import { firstSaleCampaignService } from "./first-sale-campaign.service";
import { vendorReferralsService } from "./vendor-referrals.service";

function userId(request: Request): string {
  const id = (request as Request & { user?: { id?: string } }).user?.id;
  if (!id) throw new AppError("Unauthorized", 401);
  return id;
}

/** Mounted at /growth for vendors. Each service checks the caller has a store. */
export const growthRouter = Router();
growthRouter.use(authenticate);
growthRouter.get("/referrals", asyncHandler(async (request: Request, response: Response) => {
  response.json(await vendorReferralsService.overview(userId(request)));
}));
growthRouter.get("/first-sale-campaign", asyncHandler(async (request: Request, response: Response) => {
  response.json(await firstSaleCampaignService.view(userId(request)));
}));
growthRouter.post("/first-sale-campaign/launch", asyncHandler(async (request: Request, response: Response) => {
  response.json(await firstSaleCampaignService.launch(userId(request)));
}));
