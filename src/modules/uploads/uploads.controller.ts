import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { uploadsService } from "./uploads.service";
import { validateRequestUploadInput } from "./uploads.validation";

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
