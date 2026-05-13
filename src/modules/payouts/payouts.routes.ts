import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createPayoutRequest,
  listOwnPayoutRequests,
} from "./payouts.controller";

export const payoutRequestsRouter = Router();

payoutRequestsRouter.use(authenticate, requireRole("VENDOR", "ADMIN"));

payoutRequestsRouter.post("/", asyncHandler(createPayoutRequest));
payoutRequestsRouter.get("/me", asyncHandler(listOwnPayoutRequests));
