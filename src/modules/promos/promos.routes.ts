import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireSellerPlanFeature } from "../../middlewares/require-seller-plan-feature";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createVendorPromoCode, deleteVendorPromoCode, listPublicDeals, listVendorPromoCodes, validatePromo } from "./promos.controller";

export const promosRouter = Router();

promosRouter.get("/deals", asyncHandler(listPublicDeals));
promosRouter.post("/validate", authenticate, asyncHandler(validatePromo));
promosRouter.get("/me", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(listVendorPromoCodes));
promosRouter.post(
  "/me",
  authenticate,
  requireRole("VENDOR", "ADMIN"),
  asyncHandler(requireSellerPlanFeature("discounts")),
  asyncHandler(createVendorPromoCode),
);
promosRouter.delete(
  "/me/:id",
  authenticate,
  requireRole("VENDOR", "ADMIN"),
  asyncHandler(deleteVendorPromoCode),
);
