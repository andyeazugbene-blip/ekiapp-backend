import { Router } from "express";

import { optionalAuthenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createPublicStoreCheckoutSession,
  getPublicStorePromo,
  getPublicStore,
  requestGlobalPublicStoreOrderLookup,
  requestPublicStoreOrderLookup,
  trackPublicStoreEvent,
  listPublicStoreProducts,
  verifyPublicStoreOrderLookup,
  verifyGlobalPublicStoreOrderLookup,
} from "./public-stores.controller";

/**
 * Public storefront router — no authentication required.
 * Mounted at /api/public/stores.
 */
export const publicStoresRouter = Router();

publicStoresRouter.post("/order-lookup/request", asyncHandler(requestGlobalPublicStoreOrderLookup));
publicStoresRouter.post("/order-lookup/verify", asyncHandler(verifyGlobalPublicStoreOrderLookup));
publicStoresRouter.get("/:slug", asyncHandler(getPublicStore));
publicStoresRouter.get("/:slug/products", asyncHandler(listPublicStoreProducts));
publicStoresRouter.get("/:slug/promo/:code", asyncHandler(getPublicStorePromo));
publicStoresRouter.post("/:slug/events", optionalAuthenticate, asyncHandler(trackPublicStoreEvent));
publicStoresRouter.post("/:slug/checkout", asyncHandler(createPublicStoreCheckoutSession));
publicStoresRouter.post("/:slug/order-lookup/request", asyncHandler(requestPublicStoreOrderLookup));
publicStoresRouter.post("/:slug/order-lookup/verify", asyncHandler(verifyPublicStoreOrderLookup));
