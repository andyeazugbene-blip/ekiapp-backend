import { Router } from "express";

import { getHealth } from "./health.controller";

export const healthRouter = Router();

healthRouter.get("/health", getHealth);
