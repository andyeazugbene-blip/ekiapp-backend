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
import { buyerConfirmDelivery } from "../paystack/escrow.controller";
import { openDispute } from "../paystack/dispute.controller";

export const ordersRouter = Router();

ordersRouter.use(authenticate);

// Buyer: list own orders, get order detail
ordersRouter.get("/me", asyncHandler(listBuyerOrders));
ordersRouter.get("/:id", asyncHandler(getBuyerOrder));

// Buyer: confirm delivery with OTP (escrow orders)
ordersRouter.post("/:id/confirm-delivery", asyncHandler(buyerConfirmDelivery));

// Buyer: open dispute on escrow order
ordersRouter.post("/:id/dispute", asyncHandler(openDispute));

// Vendor: list own orders, get order detail, update status
ordersRouter.get("/vendor/list", asyncHandler(listVendorOrders));
ordersRouter.get("/vendor/:id", asyncHandler(getVendorOrder));
ordersRouter.patch("/vendor/:id/status", asyncHandler(updateVendorOrderStatus));
