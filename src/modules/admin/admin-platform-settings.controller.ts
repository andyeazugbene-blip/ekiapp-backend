import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { adminPlatformSettingsService } from "./admin-platform-settings.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function listOperationalThresholds(_request: Request, response: Response): Promise<void> {
  const settings = await adminPlatformSettingsService.list();
  response.json({ settings });
}

export async function updateOperationalThreshold(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const key = typeof request.params.key === "string" ? request.params.key : "";
  const { value, reason } = (request.body ?? {}) as { value?: unknown; reason?: unknown };
  const updated = await adminPlatformSettingsService.setValue(
    key,
    value,
    adminId,
    typeof reason === "string" && reason.trim() ? reason.trim() : undefined,
    request,
  );
  response.json({ setting: updated });
}
