import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { vendorStorePreviewService } from "./vendor-store-preview.service";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function getMyStorePreview(request: Request, response: Response): Promise<void> {
  const data = await vendorStorePreviewService.getPreview(requireUserId(request));
  response.status(200).json(data);
}

export async function getMyReadiness(request: Request, response: Response): Promise<void> {
  const data = await vendorStorePreviewService.getReadiness(requireUserId(request));
  response.status(200).json(data);
}
