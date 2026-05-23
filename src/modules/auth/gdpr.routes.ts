import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { dataExport, deleteAccount } from "./gdpr.controller";

export const gdprRouter = Router();

gdprRouter.get("/data-export", authenticate, asyncHandler(dataExport));
gdprRouter.post("/delete-account", authenticate, asyncHandler(deleteAccount));
