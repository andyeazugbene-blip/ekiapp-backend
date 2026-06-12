import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireAdminPermission } from "../../middlewares/require-admin-permission";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  adminCreateGiftCard,
  adminDeleteGiftCard,
  adminListGiftCards,
  adminUpdateGiftCard,
  listActiveGiftCards,
  listPurchasedGiftCards,
  purchaseGiftCard,
} from "./gift-cards.controller";

export const giftCardsRouter = Router();
export const adminGiftCardsRouter = Router();

// Admin routes (mounted at /api/admin/gift-cards)
adminGiftCardsRouter.get("/", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.read")), asyncHandler(adminListGiftCards));
adminGiftCardsRouter.post("/", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.mutate")), asyncHandler(adminCreateGiftCard));
adminGiftCardsRouter.patch("/:id", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.mutate")), asyncHandler(adminUpdateGiftCard));
adminGiftCardsRouter.delete("/:id", authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.mutate")), asyncHandler(adminDeleteGiftCard));

// Buyer routes (mounted at /api/gift-cards)
giftCardsRouter.get("/active", asyncHandler(listActiveGiftCards));
giftCardsRouter.post("/purchase", authenticate, asyncHandler(purchaseGiftCard));
giftCardsRouter.get("/me", authenticate, asyncHandler(listPurchasedGiftCards));
