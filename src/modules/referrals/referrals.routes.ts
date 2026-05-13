import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { getReferralInfo } from "./referrals.controller";

export const referralsRouter = Router();

referralsRouter.use(authenticate);

// Get referral code + stats
referralsRouter.get("/me", asyncHandler(getReferralInfo));
