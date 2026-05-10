import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { notificationsService, parseListQuery } from "./notifications.service";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

export async function listNotifications(request: Request, response: Response): Promise<void> {
  const query = parseListQuery(request.query as Record<string, unknown>);
  const result = await notificationsService.list(requireUserId(request), query);
  response.status(200).json(result);
}

export async function markNotificationRead(
  request: Request,
  response: Response,
): Promise<void> {
  const notification = await notificationsService.markRead(
    requireUserId(request),
    requireIdParam(request),
  );
  response.status(200).json({ notification });
}
