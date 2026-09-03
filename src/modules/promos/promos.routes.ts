import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireSellerPlanFeature } from "../../middlewares/require-seller-plan-feature";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createVendorPromoCode, deleteVendorPromoCode, listPublicDeals, listVendorPromoCodes, validatePromo } from "./promos.controller";
import { createBundle, deleteBundle, listMyBundles, listPublicBundles, updateBundleActive } from "./bundles.controller";
import { createFlashSale, deleteFlashSale, listMyFlashSales, listPublicFlashSales, updateFlashSaleActive } from "./flash-sales.controller";

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

// Bundle — real structured data (client mandate 2026-09), replacing the
// old PromoCode "BUNDLE"-prefix hack. Still redeems through the same
// PromoCode mechanism under the hood — see bundles.service.ts.
export const bundlesRouter = Router();
bundlesRouter.get("/public", asyncHandler(listPublicBundles));
bundlesRouter.get("/me", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(listMyBundles));
bundlesRouter.post("/me", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(requireSellerPlanFeature("bundles")), asyncHandler(createBundle));
bundlesRouter.patch("/me/:id", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(updateBundleActive));
bundlesRouter.delete("/me/:id", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(deleteBundle));

// Flash Sale — real structured data with real start/end validation
// (client mandate 2026-09), replacing the old PromoCode "FLASH"-prefix
// hack. Still redeems through the same PromoCode mechanism under the
// hood — see flash-sales.service.ts.
export const flashSalesRouter = Router();
flashSalesRouter.get("/public", asyncHandler(listPublicFlashSales));
flashSalesRouter.get("/me", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(listMyFlashSales));
flashSalesRouter.post("/me", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(requireSellerPlanFeature("flashSales")), asyncHandler(createFlashSale));
flashSalesRouter.patch("/me/:id", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(updateFlashSaleActive));
flashSalesRouter.delete("/me/:id", authenticate, requireRole("VENDOR", "ADMIN"), asyncHandler(deleteFlashSale));
