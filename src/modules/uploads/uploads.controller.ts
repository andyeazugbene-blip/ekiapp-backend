import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { uploadsService } from "./uploads.service";
import { validateCompleteUploadInput, validateRequestUploadInput } from "./uploads.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function requestUploadUrl(request: Request, response: Response): Promise<void> {
  const input = validateRequestUploadInput(request.body);
  const result = await uploadsService.requestUploadUrl(requireUserId(request), input);
  response.status(200).json(result);
}

export async function completeUpload(request: Request, response: Response): Promise<void> {
  const input = validateCompleteUploadInput(request.body);
  const result = await uploadsService.completeUpload(requireUserId(request), input);
  response.status(200).json(result);
}

export async function adminListUploads(request: Request, response: Response): Promise<void> {
  const category = typeof request.query.category === "string" ? request.query.category : undefined;
  const status = typeof request.query.status === "string" ? request.query.status.toUpperCase() : undefined;
  const assets = await uploadsService.listAdminUploads({ category, status });
  response.status(200).json({ assets });
}

export async function adminGetUploadReadUrl(request: Request, response: Response): Promise<void> {
  const assetId = typeof request.params.id === "string" ? request.params.id : "";
  if (!assetId) throw new AppError("Invalid upload asset id", 400);
  response.status(200).json(await uploadsService.getAdminReadUrl(assetId));
}
