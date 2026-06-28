import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  activateSubscription,
  cancelSubscription,
  createBillingPortalSession,
  createCheckoutSession,
  createWebCheckoutSession,
  getPlanLimits,
  getPlans,
  getSubscription,
  getVendorAccount,
} from "./subscriptions.controller";

export const subscriptionsRouter = Router();

// Public: list available plans
subscriptionsRouter.get("/plans", asyncHandler(getPlans));
subscriptionsRouter.post("/web-checkout", asyncHandler(createWebCheckoutSession));
subscriptionsRouter.post("/billing-portal", asyncHandler(createBillingPortalSession));

// Authenticated (vendor)
subscriptionsRouter.use(authenticate);
subscriptionsRouter.get("/me", asyncHandler(getSubscription));
subscriptionsRouter.get("/me/limits", asyncHandler(getPlanLimits));
subscriptionsRouter.post("/activate", requireRole("VENDOR", "ADMIN"), asyncHandler(activateSubscription));
subscriptionsRouter.post("/checkout", asyncHandler(createCheckoutSession));
subscriptionsRouter.post("/cancel", asyncHandler(cancelSubscription));

export const vendorAccountRouter = Router();
vendorAccountRouter.use(authenticate);
vendorAccountRouter.get("/account", asyncHandler(getVendorAccount));
