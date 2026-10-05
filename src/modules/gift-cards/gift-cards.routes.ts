import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireAdminPermission } from "../../middlewares/require-admin-permission";
import { require2fa } from "../../middlewares/require-2fa";
import { giftCardRedeemRateLimiter } from "../../middlewares/rate-limit";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  adminArchiveGiftCard,
  adminCancelPurchasedGiftCard,
  adminCreateGiftCard,
  adminGetPurchasedGiftCard,
  adminListGiftCards,
  adminListPurchasedGiftCards,
  adminPauseGiftCard,
  adminPausePurchasedGiftCard,
  adminResumeGiftCard,
  adminResumePurchasedGiftCard,
  adminUpdateGiftCard,
  listActiveGiftCards,
  listPurchasedGiftCards,
  purchaseGiftCard,
  redeemGiftCard,
} from "./gift-cards.controller";

export const giftCardsRouter = Router();
export const adminGiftCardsRouter = Router();

const read = [authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.read"))];
const mutate = [authenticate, requireRole("ADMIN"), asyncHandler(requireAdminPermission("rewards.mutate"))];

// Admin routes (mounted at /api/admin/gift-cards). There is deliberately NO
// DELETE: gift cards are paused / archived, never hard-deleted (handbook 14.4).
adminGiftCardsRouter.get("/", ...read, asyncHandler(adminListGiftCards));
adminGiftCardsRouter.post("/", ...mutate, asyncHandler(adminCreateGiftCard));
// Purchased cards (registered before "/:id").
adminGiftCardsRouter.get("/purchased", ...read, asyncHandler(adminListPurchasedGiftCards));
adminGiftCardsRouter.get("/purchased/:id", ...read, asyncHandler(adminGetPurchasedGiftCard));
adminGiftCardsRouter.post("/purchased/:id/cancel", ...mutate, asyncHandler(require2fa), asyncHandler(adminCancelPurchasedGiftCard));
adminGiftCardsRouter.post("/purchased/:id/pause", ...mutate, asyncHandler(adminPausePurchasedGiftCard));
adminGiftCardsRouter.post("/purchased/:id/resume", ...mutate, asyncHandler(adminResumePurchasedGiftCard));
// Catalogue
adminGiftCardsRouter.patch("/:id", ...mutate, asyncHandler(adminUpdateGiftCard));
adminGiftCardsRouter.post("/:id/pause", ...mutate, asyncHandler(adminPauseGiftCard));
adminGiftCardsRouter.post("/:id/resume", ...mutate, asyncHandler(adminResumeGiftCard));
adminGiftCardsRouter.post("/:id/archive", ...mutate, asyncHandler(adminArchiveGiftCard));

// Buyer routes (mounted at /api/gift-cards)
giftCardsRouter.get("/active", asyncHandler(listActiveGiftCards));
giftCardsRouter.post("/purchase", authenticate, asyncHandler(purchaseGiftCard));
giftCardsRouter.get("/me", authenticate, asyncHandler(listPurchasedGiftCards));
giftCardsRouter.post("/redeem", authenticate, giftCardRedeemRateLimiter, asyncHandler(redeemGiftCard));
