import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  listVendorAutomationActivity,
  listVendorAutomations,
  updateVendorAutomation,
} from "./automation.controller";

// Mounted at /vendor alongside vendorAccountRouter (subscriptions.routes.ts) —
// same base path, disjoint sub-paths, no conflict.
export const automationVendorRouter = Router();
automationVendorRouter.use(authenticate, requireRole("VENDOR"));
automationVendorRouter.get("/automations", asyncHandler(listVendorAutomations));
automationVendorRouter.patch("/automations/:id", asyncHandler(updateVendorAutomation));
automationVendorRouter.get("/automations/activity", asyncHandler(listVendorAutomationActivity));
