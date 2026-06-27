import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  submitReport,
  blockUserHandler,
  unblockUserHandler,
  listBlockedUsers,
} from "./reports.controller";

export const reportsRouter = Router();

// Authenticated: submit a content report
reportsRouter.post("/", authenticate, asyncHandler(submitReport));

// Authenticated: block/unblock users
reportsRouter.post("/block", authenticate, asyncHandler(blockUserHandler));
reportsRouter.get("/blocked", authenticate, asyncHandler(listBlockedUsers));
reportsRouter.delete("/block/:blockedId", authenticate, asyncHandler(unblockUserHandler));
