import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  completeBuyerOrder,
  getBuyerOrder,
  getVendorOrder,
  listBuyerOrders,
  listVendorOrders,
  updateDeliveryAddress,
  updateVendorOrderStatus,
} from "./orders.controller";
import { buyerConfirmDelivery, resendBuyerDeliveryOtp } from "../paystack/escrow.controller";
import { openDispute } from "../paystack/dispute.controller";

export const ordersRouter = Router();

ordersRouter.use(authenticate);

// Buyer: list own orders, get order detail
ordersRouter.get("/me", asyncHandler(listBuyerOrders));
ordersRouter.get("/:id", asyncHandler(getBuyerOrder));

// Buyer: mark delivered order as completed (received)
ordersRouter.post("/:id/complete", asyncHandler(completeBuyerOrder));

// Buyer: update delivery address on an existing order (before dispatch)
ordersRouter.patch("/:id/delivery-address", asyncHandler(updateDeliveryAddress));

// Buyer: confirm delivery with OTP (escrow orders)
ordersRouter.post("/:id/confirm-delivery", asyncHandler(buyerConfirmDelivery));
ordersRouter.post("/:id/resend-delivery-otp", asyncHandler(resendBuyerDeliveryOtp));

// Buyer: open dispute on escrow order
ordersRouter.post("/:id/dispute", asyncHandler(openDispute));

// Vendor: list own orders, get order detail, update status
ordersRouter.get("/vendor/list", asyncHandler(listVendorOrders));
ordersRouter.get("/vendor/:id", asyncHandler(getVendorOrder));
ordersRouter.patch("/vendor/:id/status", asyncHandler(updateVendorOrderStatus));
