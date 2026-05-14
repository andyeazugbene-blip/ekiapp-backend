import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { pushTokensService } from "./push-tokens.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function registerPushToken(request: Request, response: Response): Promise<void> {
  const { token, platform } = request.body as { token?: string; platform?: string };

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    throw new AppError("token is required", 400);
  }

  const pushToken = await pushTokensService.register(
    requireUserId(request),
    token.trim(),
    typeof platform === "string" ? platform.trim() : undefined,
  );

  response.status(201).json({ pushToken: { id: pushToken.id, platform: pushToken.platform } });
}

export async function removePushToken(request: Request, response: Response): Promise<void> {
  const token = request.params.token as string;
  if (!token || token.length === 0) {
    throw new AppError("Invalid token", 400);
  }

  await pushTokensService.remove(requireUserId(request), decodeURIComponent(token));
  response.status(200).json({ success: true });
}
