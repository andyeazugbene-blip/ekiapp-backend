import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createPaymentIntent } from "./payments.controller";

export const paymentsRouter = Router();

paymentsRouter.post("/create-intent", authenticate, asyncHandler(createPaymentIntent));
