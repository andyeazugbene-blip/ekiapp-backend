import { Router } from "express";

import { createPaymentIntent } from "./payments.controller";
import { asyncHandler } from "../../shared/utils/async-handler";

export const paymentsRouter = Router();

paymentsRouter.post("/create-intent", asyncHandler(createPaymentIntent));
