import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { requireVendorProfileOrAdmin } from "../../middlewares/require-capability";
import { requireSellerPlanFeature } from "../../middlewares/require-seller-plan-feature";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createVendorPromoCode, deleteVendorPromoCode, listPublicDeals, listVendorPromoCodes, validatePromo } from "./promos.controller";
import { createBundle, deleteBundle, listMyBundles, listPublicBundles, updateBundleActive } from "./bundles.controller";
import { createFlashSale, deleteFlashSale, listMyFlashSales, listPublicFlashSales, updateFlashSaleActive } from "./flash-sales.controller";

export const promosRouter = Router();

promosRouter.get("/deals", asyncHandler(listPublicDeals));
promosRouter.post("/validate", authenticate, asyncHandler(validatePromo));
promosRouter.get("/me", authenticate, requireVendorProfileOrAdmin(), asyncHandler(listVendorPromoCodes));
promosRouter.post(
  "/me",
  authenticate,
  requireVendorProfileOrAdmin(),
  asyncHandler(requireSellerPlanFeature("discounts")),
  asyncHandler(createVendorPromoCode),
);
promosRouter.delete(
  "/me/:id",
  authenticate,
  requireVendorProfileOrAdmin(),
  asyncHandler(deleteVendorPromoCode),
);

// Bundle — real structured data (client mandate 2026-09), replacing the
// old PromoCode "BUNDLE"-prefix hack. Still redeems through the same
// PromoCode mechanism under the hood — see bundles.service.ts.
export const bundlesRouter = Router();
bundlesRouter.get("/public", asyncHandler(listPublicBundles));
bundlesRouter.get("/me", authenticate, requireVendorProfileOrAdmin(), asyncHandler(listMyBundles));
bundlesRouter.post("/me", authenticate, requireVendorProfileOrAdmin(), asyncHandler(requireSellerPlanFeature("bundles")), asyncHandler(createBundle));
bundlesRouter.patch("/me/:id", authenticate, requireVendorProfileOrAdmin(), asyncHandler(updateBundleActive));
bundlesRouter.delete("/me/:id", authenticate, requireVendorProfileOrAdmin(), asyncHandler(deleteBundle));

// Flash Sale — real structured data with real start/end validation
// (client mandate 2026-09), replacing the old PromoCode "FLASH"-prefix
// hack. Still redeems through the same PromoCode mechanism under the
// hood — see flash-sales.service.ts.
export const flashSalesRouter = Router();
flashSalesRouter.get("/public", asyncHandler(listPublicFlashSales));
flashSalesRouter.get("/me", authenticate, requireVendorProfileOrAdmin(), asyncHandler(listMyFlashSales));
flashSalesRouter.post("/me", authenticate, requireVendorProfileOrAdmin(), asyncHandler(requireSellerPlanFeature("flashSales")), asyncHandler(createFlashSale));
flashSalesRouter.patch("/me/:id", authenticate, requireVendorProfileOrAdmin(), asyncHandler(updateFlashSaleActive));
flashSalesRouter.delete("/me/:id", authenticate, requireVendorProfileOrAdmin(), asyncHandler(deleteFlashSale));
