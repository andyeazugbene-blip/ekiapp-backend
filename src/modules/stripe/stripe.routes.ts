import { Router } from "express";

import { asyncHandler } from "../../shared/utils/async-handler";
import { handleStripeWebhook } from "./stripe.controller";

export const stripeRouter = Router();

stripeRouter.get("/webhook", (_req, res) => {
  res.status(200).json({ status: "ok", message: "Stripe webhook endpoint ready" });
});

stripeRouter.post("/webhook", asyncHandler(handleStripeWebhook));
