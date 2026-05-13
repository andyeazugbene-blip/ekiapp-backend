import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getOwnVerification,
  submitVerificationDocument,
} from "./verification.controller";

export const verificationRouter = Router();

verificationRouter.use(authenticate);

// Vendor: submit documents and check status
verificationRouter.post("/", asyncHandler(submitVerificationDocument));
verificationRouter.get("/", asyncHandler(getOwnVerification));
