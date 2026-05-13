import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  cancelSubscription,
  createCheckoutSession,
  getPlanLimits,
  getPlans,
  getSubscription,
} from "./subscriptions.controller";

export const subscriptionsRouter = Router();

// Public: list available plans
subscriptionsRouter.get("/plans", asyncHandler(getPlans));

// Authenticated (vendor)
subscriptionsRouter.use(authenticate);
subscriptionsRouter.get("/me", asyncHandler(getSubscription));
subscriptionsRouter.get("/me/limits", asyncHandler(getPlanLimits));
subscriptionsRouter.post("/checkout", asyncHandler(createCheckoutSession));
subscriptionsRouter.post("/cancel", asyncHandler(cancelSubscription));
