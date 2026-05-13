import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { paymentsRateLimiter } from "../../middlewares/rate-limit";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createPaymentIntent } from "./payments.controller";

export const paymentsRouter = Router();

paymentsRouter.post(
  "/create-intent",
  paymentsRateLimiter,
  authenticate,
  asyncHandler(createPaymentIntent),
);
