import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  addCartItem,
  clearCart,
  getCart,
  removeCartItem,
  updateCartItem,
} from "./cart.controller";

export const cartRouter = Router();

cartRouter.use(authenticate);

cartRouter.get("/", asyncHandler(getCart));
cartRouter.post("/items", asyncHandler(addCartItem));
cartRouter.patch("/items/:id", asyncHandler(updateCartItem));
cartRouter.delete("/items/:id", asyncHandler(removeCartItem));
cartRouter.delete("/", asyncHandler(clearCart));
