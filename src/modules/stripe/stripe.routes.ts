import { Router } from "express";

import { asyncHandler } from "../../shared/utils/async-handler";
import { handleStripeWebhook } from "./stripe.controller";

export const stripeRouter = Router();

stripeRouter.post("/webhook", asyncHandler(handleStripeWebhook));
