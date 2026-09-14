import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { requireVendorProfile } from "../../middlewares/require-capability";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createProduct,
  disableProduct,
  getMyProduct,
  getProduct,
  listMyProducts,
  listProducts,
  updateProduct,
} from "./products.controller";

export const productsRouter = Router();

productsRouter.get("/", asyncHandler(listProducts));
productsRouter.get("/me", authenticate, requireVendorProfile(), asyncHandler(listMyProducts));
productsRouter.get("/me/:id", authenticate, requireVendorProfile(), asyncHandler(getMyProduct));
productsRouter.get("/:id", asyncHandler(getProduct));

productsRouter.post("/", authenticate, requireVendorProfile(), asyncHandler(createProduct));
productsRouter.patch("/:id", authenticate, requireVendorProfile(), asyncHandler(updateProduct));
productsRouter.delete("/:id", authenticate, requireVendorProfile(), asyncHandler(disableProduct));
