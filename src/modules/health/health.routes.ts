import { Router } from "express";

import { asyncHandler } from "../../shared/utils/async-handler";
import { getHealth, getHealthDetailed, sentryTest } from "./health.controller";

export const healthRouter = Router();

healthRouter.get("/health", getHealth);
healthRouter.get("/health/detailed", asyncHandler(getHealthDetailed));
healthRouter.get("/health/sentry-test", sentryTest);
