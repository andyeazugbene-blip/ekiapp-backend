import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notificationsService, parseListQuery, type OrchestrationPreferenceInput } from "./notifications.service";

const preferenceChannels = new Set(["PUSH", "IN_APP", "EMAIL", "SMS", "WHATSAPP"]);
const preferenceCategories = new Set(["SERVICE", "MARKETING"]);
const preferenceConsents = new Set(["OPTED_IN", "OPTED_OUT", "NOT_REQUIRED_FOR_SERVICE", "UNKNOWN"]);
const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function parseOrchestrationPreferences(value: unknown): OrchestrationPreferenceInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new AppError("orchestration must be an array of up to 10 preferences", 400);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError(`orchestration[${index}] must be an object`, 400);
    const item = raw as Record<string, unknown>;
    if (typeof item.channel !== "string" || !preferenceChannels.has(item.channel)
      || typeof item.category !== "string" || !preferenceCategories.has(item.category)
      || typeof item.consent !== "string" || !preferenceConsents.has(item.consent)) {
      throw new AppError(`orchestration[${index}] has an invalid channel, category, or consent`, 400);
    }
    const identity = `${item.channel}:${item.category}`;
    if (seen.has(identity)) throw new AppError(`orchestration contains duplicate ${identity}`, 400);
    seen.add(identity);
    if (item.category === "MARKETING" && item.consent === "NOT_REQUIRED_FOR_SERVICE") {
      throw new AppError(`orchestration[${index}] marketing consent cannot be not_required_for_service`, 400);
    }
    const timezone = item.timezone;
    if (timezone !== undefined && (typeof timezone !== "string" || timezone.length > 100
      || !isValidTimezone(timezone))) throw new AppError(`orchestration[${index}].timezone must be an IANA timezone`, 400);
    const start = item.quietHoursStart;
    const end = item.quietHoursEnd;
    if ((start !== undefined && start !== null && (typeof start !== "string" || !validTime.test(start)))
      || (end !== undefined && end !== null && (typeof end !== "string" || !validTime.test(end)))
      || ((start == null) !== (end == null))) {
      throw new AppError(`orchestration[${index}] quiet hours must be a valid start/end pair`, 400);
    }
    return {
      channel: item.channel as OrchestrationPreferenceInput["channel"],
      category: item.category as OrchestrationPreferenceInput["category"],
      consent: item.consent as OrchestrationPreferenceInput["consent"],
      ...(timezone === undefined ? {} : { timezone: timezone as string }),
      ...(start === undefined ? {} : { quietHoursStart: start as string | null }),
      ...(end === undefined ? {} : { quietHoursEnd: end as string | null }),
    };
  });
}

function isValidTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; }
  catch { return false; }
}

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

export async function getUnreadNotificationCount(request: Request, response: Response): Promise<void> {
  const result = await notificationsService.getUnreadCount(requireUserId(request));
  response.status(200).json(result);
}

export async function getNotificationPreferences(request: Request, response: Response): Promise<void> {
  const preferences = await notificationsService.getPreferences(requireUserId(request));
  const orchestration = await notificationsService.getOrchestrationPreferences(requireUserId(request));
  response.status(200).json({
    smsMarketing: preferences.smsMarketingConsentAt != null,
    smsTransactional: preferences.smsTransactionalEnabled,
    marketingConsent: preferences.marketingConsentAt != null,
    orchestration,
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
  const orchestration = parseOrchestrationPreferences(raw.orchestration);
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
  const orchestrationPreferences = orchestration === undefined
    ? await notificationsService.getOrchestrationPreferences(userId)
    : await notificationsService.updateOrchestrationPreferences(userId, orchestration);

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
    orchestration: orchestrationPreferences,
  });
}
