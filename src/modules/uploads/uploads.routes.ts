import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { requestUploadUrl } from "./uploads.controller";

export const uploadsRouter = Router();

uploadsRouter.use(authenticate);

// Request a presigned upload URL
uploadsRouter.post("/request-url", asyncHandler(requestUploadUrl));
