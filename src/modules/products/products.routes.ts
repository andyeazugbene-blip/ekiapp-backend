import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createProduct,
  disableProduct,
  getProduct,
  listProducts,
  updateProduct,
} from "./products.controller";

export const productsRouter = Router();

productsRouter.get("/", asyncHandler(listProducts));
productsRouter.get("/:id", asyncHandler(getProduct));

productsRouter.post("/", authenticate, requireRole("VENDOR"), asyncHandler(createProduct));
productsRouter.patch("/:id", authenticate, requireRole("VENDOR"), asyncHandler(updateProduct));
productsRouter.delete("/:id", authenticate, requireRole("VENDOR"), asyncHandler(disableProduct));
