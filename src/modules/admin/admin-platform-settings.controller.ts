import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { requireAuditReason } from "../../shared/utils/audit";
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
  const updated = await adminPlatformSettingsService.setValue(key, value, adminId, requireAuditReason(reason), request);
  response.json({ setting: updated });
}

export async function listPlatformFlags(_request: Request, response: Response): Promise<void> {
  response.json({ flags: await adminPlatformSettingsService.listFlags() });
}

export async function upsertPlatformFlag(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const key = typeof request.params.key === "string" ? request.params.key : "";
  const body = (request.body ?? {}) as { enabled?: unknown; description?: unknown; reason?: unknown };
  const flag = await adminPlatformSettingsService.setFlag(key, body, adminId, body.reason, request);
  response.json({ flag });
}

export async function getSettingHistory(request: Request, response: Response): Promise<void> {
  const key = typeof request.params.key === "string" ? request.params.key : "";
  response.json({ history: await adminPlatformSettingsService.history(key) });
}
