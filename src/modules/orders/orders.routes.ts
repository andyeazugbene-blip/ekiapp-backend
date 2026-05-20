import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getBuyerOrder,
  getVendorOrder,
  listBuyerOrders,
  listVendorOrders,
  updateVendorOrderStatus,
} from "./orders.controller";

export const ordersRouter = Router();

ordersRouter.use(authenticate);

// Buyer: list own orders, get order detail
ordersRouter.get("/me", asyncHandler(listBuyerOrders));
ordersRouter.get("/:id", asyncHandler(getBuyerOrder));

// Vendor: list own orders, get order detail, update status
ordersRouter.get("/vendor/list", asyncHandler(listVendorOrders));
ordersRouter.get("/vendor/:id", asyncHandler(getVendorOrder));
ordersRouter.patch("/vendor/:id/status", asyncHandler(updateVendorOrderStatus));
