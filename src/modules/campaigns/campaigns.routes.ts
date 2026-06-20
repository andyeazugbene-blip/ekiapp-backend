import { Router } from "express";

import { optionalAuthenticate, authenticate, requireRole } from "../../middlewares/authenticate";
import { requireAdminPermission } from "../../middlewares/require-admin-permission";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  adminCreateCampaign,
  adminDeleteCampaign,
  adminListCampaigns,
  adminUpdateCampaign,
  listMyCampaigns,
} from "./campaigns.controller";

export const campaignsRouter = Router();
export const adminCampaignsRouter = Router();

// Admin routes (mounted at /api/admin/campaigns)
adminCampaignsRouter.get("/", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("campaigns.read")), asyncHandler(adminListCampaigns));
adminCampaignsRouter.post("/", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("campaigns.mutate")), asyncHandler(adminCreateCampaign));
adminCampaignsRouter.patch("/:id", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("campaigns.mutate")), asyncHandler(adminUpdateCampaign));
adminCampaignsRouter.delete("/:id", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("campaigns.mutate")), asyncHandler(adminDeleteCampaign));

// Buyer route (mounted at /api/campaigns) — eligibility evaluated server-side
campaignsRouter.get("/me", optionalAuthenticate, asyncHandler(listMyCampaigns));
