import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { completeUpload, requestUploadUrl } from "./uploads.controller";

export const uploadsRouter = Router();

// Mock upload for local dev/testing
uploadsRouter.put("/mock-upload", (_req, res) => {
  res.status(200).send();
});

// Mock download for local dev/testing
uploadsRouter.get("/mock-download", (_req, res) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  res.setHeader("Content-Type", "image/png");
  res.status(200).send(png);
});

uploadsRouter.use(authenticate);

// Request a presigned upload URL
uploadsRouter.post("/request-url", asyncHandler(requestUploadUrl));
uploadsRouter.post("/complete", asyncHandler(completeUpload));
