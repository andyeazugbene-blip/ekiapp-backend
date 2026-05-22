import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  handlePaystackWebhook,
  initializePaystackPayment,
  verifyPaystackPayment,
} from "./paystack.controller";

export const paystackRouter = Router();

// Public webhook endpoint (Paystack sends events here)
paystackRouter.post("/webhook", asyncHandler(handlePaystackWebhook));

// Authenticated buyer endpoints
paystackRouter.post("/initialize", authenticate, asyncHandler(initializePaystackPayment));
paystackRouter.get("/verify/:reference", authenticate, asyncHandler(verifyPaystackPayment));
