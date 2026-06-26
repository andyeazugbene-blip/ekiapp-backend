import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createStripeVerificationSession,
  getOwnVerification,
  getStripeVerificationStatus,
  resetVerification,
  submitVerificationDocument,
} from "./verification.controller";

export const verificationRouter = Router();

verificationRouter.use(authenticate);

// Stripe Identity verification (new flow)
verificationRouter.post("/stripe-session", asyncHandler(createStripeVerificationSession));
verificationRouter.get("/stripe-status", asyncHandler(getStripeVerificationStatus));

// Legacy: document upload verification (deprecated — kept for backward compat)
verificationRouter.post("/", asyncHandler(submitVerificationDocument));
verificationRouter.get("/", asyncHandler(getOwnVerification));
verificationRouter.delete("/", asyncHandler(resetVerification));
