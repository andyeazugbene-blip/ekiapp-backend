import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
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

export async function markAllNotificationsRead(
  request: Request,
  response: Response,
): Promise<void> {
  const result = await notificationsService.markAllRead(requireUserId(request));
  response.status(200).json(result);
}

export async function getNotificationPreferences(request: Request, response: Response): Promise<void> {
  const preferences = await notificationsService.getPreferences(requireUserId(request));
  response.status(200).json({
    smsMarketing: preferences.smsMarketingConsentAt != null,
    smsTransactional: preferences.smsTransactionalEnabled,
    marketingConsent: preferences.marketingConsentAt != null,
  });
}

export async function testPushNotification(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const { title, body, type } = request.body as { title?: string; body?: string; type?: string };
  await notificationsService.enqueue({
    userId,
    type: (type ?? "SYSTEM") as any,
    title: title ?? "Test Notification",
    body: body ?? "This is a test push notification from Eki.",
    data: { type: type ?? "system" },
  });
  response.status(200).json({ message: "Test notification sent" });
}

export async function updateNotificationPreferences(request: Request, response: Response): Promise<void> {
  const raw = (request.body ?? {}) as Record<string, unknown>;
  if (raw.smsMarketing !== undefined && typeof raw.smsMarketing !== "boolean") {
    throw new AppError("smsMarketing must be a boolean", 400);
  }
  if (raw.smsTransactional !== undefined && typeof raw.smsTransactional !== "boolean") {
    throw new AppError("smsTransactional must be a boolean", 400);
  }
  if (raw.marketingConsent !== undefined && typeof raw.marketingConsent !== "boolean") {
    throw new AppError("marketingConsent must be a boolean", 400);
  }

  const userId = requireUserId(request);
  // Captured before the write so a grant/revoke is audited with both
  // states, not just the new one — the same recordAudit convention used
  // throughout the rest of the backend for consent/permission changes.
  const before = raw.marketingConsent !== undefined ? await notificationsService.getPreferences(userId) : null;

  const preferences = await notificationsService.updatePreferences(userId, {
    smsMarketing: raw.smsMarketing as boolean | undefined,
    smsTransactional: raw.smsTransactional as boolean | undefined,
    marketingConsent: raw.marketingConsent as boolean | undefined,
  });

  if (before) {
    await recordAudit({
      actorId: userId,
      action: raw.marketingConsent ? "user.marketing_consent.granted" : "user.marketing_consent.revoked",
      entityType: "User",
      entityId: userId,
      beforeState: { marketingConsentAt: before.marketingConsentAt },
      afterState: { marketingConsentAt: preferences.marketingConsentAt },
      request,
    });
  }

  response.status(200).json({
    smsMarketing: preferences.smsMarketingConsentAt != null,
    smsTransactional: preferences.smsTransactionalEnabled,
    marketingConsent: preferences.marketingConsentAt != null,
  });
}
