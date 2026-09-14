import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { requireVendorProfileOrAdmin } from "../../middlewares/require-capability";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createPayoutRequest,
  listOwnPayoutRequests,
  listOwnPayoutRequestsWithDetails,
} from "./payouts.controller";

export const payoutRequestsRouter = Router();

payoutRequestsRouter.use(authenticate, requireVendorProfileOrAdmin());

payoutRequestsRouter.post("/", asyncHandler(createPayoutRequest));
payoutRequestsRouter.get("/me", asyncHandler(listOwnPayoutRequests));
payoutRequestsRouter.get("/me/history", asyncHandler(listOwnPayoutRequestsWithDetails));
