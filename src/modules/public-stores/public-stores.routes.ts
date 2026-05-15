import { Router } from "express";

import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getPublicStore,
  listPublicStoreProducts,
} from "./public-stores.controller";

/**
 * Public storefront router — no authentication required.
 * Mounted at /api/public/stores.
 */
export const publicStoresRouter = Router();

publicStoresRouter.get("/:slug", asyncHandler(getPublicStore));
publicStoresRouter.get("/:slug/products", asyncHandler(listPublicStoreProducts));
