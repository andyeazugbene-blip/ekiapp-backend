import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireAdminPermission } from "../../middlewares/require-admin-permission";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  adminCreateReward,
  adminDeleteReward,
  adminListRewards,
  adminUpdateReward,
  claimReward,
  getUserRewards,
  listActiveRewards,
} from "./rewards.controller";

export const rewardsRouter = Router();
export const adminRewardsRouter = Router();

// Admin routes (mounted at /api/admin/rewards)
adminRewardsRouter.get("/", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.read")), asyncHandler(adminListRewards));
adminRewardsRouter.post("/", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.mutate")), asyncHandler(adminCreateReward));
adminRewardsRouter.patch("/:id", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.mutate")), asyncHandler(adminUpdateReward));
adminRewardsRouter.delete("/:id", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.mutate")), asyncHandler(adminDeleteReward));

// Buyer routes (mounted at /api/rewards)
rewardsRouter.get("/active", asyncHandler(listActiveRewards));
rewardsRouter.post("/claim", authenticate, asyncHandler(claimReward));
rewardsRouter.get("/me", authenticate, asyncHandler(getUserRewards));
