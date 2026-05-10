import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { calculateDelivery } from "./delivery.controller";

export const deliveryRouter = Router();

deliveryRouter.post("/calculate", authenticate, asyncHandler(calculateDelivery));
