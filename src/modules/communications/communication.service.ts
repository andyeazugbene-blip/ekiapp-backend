import type { NotificationType, Prisma } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { enqueueEmail } from "../../lib/email-queue";
import { sendPushToUser } from "../../lib/expo-push";
import { notificationsService } from "../notifications/notifications.service";
import { commsPauseService, PAUSE_REASON } from "./comms-pause.service";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import type { Request } from "express";
import { emitMessageEvent, type MessageOutcome } from "./message-events";

// ─── Template definitions ───────────────────────────────────────────────────

interface CommunicationTemplate {
  key: string;
  title: string;
  body: string;
  channels: ("email" | "push" | "in_app")[];
  enabled: boolean;
  recipientType: "BUYER" | "VENDOR";
}

const TEMPLATES: Record<string, CommunicationTemplate> = {
  welcome_buyer: {
    key: "welcome_buyer",
    title: "Welcome to Eki Marketplace!",
    body: "Hi {{name}}, thanks for joining Eki Marketplace. Browse authentic African foodstuff from verified vendors.",
    channels: ["email", "in_app"],
    enabled: true,
    recipientType: "BUYER",
  },
  welcome_vendor: {
    key: "welcome_vendor",
    title: "Welcome to Eki Seller",
    body: "Hi {{name}}, your seller account is ready. Complete your store profile and start selling.",
    channels: ["email", "in_app"],
    enabled: true,
    recipientType: "VENDOR",
  },
  vendor_verification_approved: {
    key: "vendor_verification_approved",
    title: "Your store has been verified!",
    body: "Congratulations {{store_name}}! Your store has been verified. You can now list products and start selling on Eki Marketplace.",
    channels: ["email", "push", "in_app"],
    enabled: true,
    recipientType: "VENDOR",
  },
  vendor_verification_rejected: {
    key: "vendor_verification_rejected",
    title: "Verification update",
    body: "Hi {{store_name}}, we couldn't complete your verification. {{reason}} Please try again or contact support.",
    channels: ["email", "push", "in_app"],
    enabled: true,
    recipientType: "VENDOR",
  },
  vendor_first_order: {
    key: "vendor_first_order",
    title: "Your first order!",
    body: "Congratulations {{store_name}}! You just received your first order ({{order_number}}). This is a big milestone!",
    channels: ["email", "push", "in_app"],
    enabled: true,
    recipientType: "VENDOR",
  },
  buyer_order_confirmed: {
    key: "buyer_order_confirmed",
    title: "Order confirmed: {{order_number}}",
    body: "Hi {{name}}, your order {{order_number}} has been confirmed. Total: {{amount}}.",
    channels: ["email", "push", "in_app"],
    enabled: true,
    recipientType: "BUYER",
  },
  buyer_order_shipped: {
    key: "buyer_order_shipped",
    title: "Your order is on its way!",
    body: "Hi {{name}}, your order {{order_number}} has been dispatched.",
    channels: ["email", "push", "in_app"],
    enabled: true,
    recipientType: "BUYER",
  },
  buyer_order_delivered: {
    key: "buyer_order_delivered",
    title: "Order delivered!",
    body: "Hi {{name}}, your order {{order_number}} has been delivered. Please confirm receipt in the app.",
    channels: ["email", "push", "in_app"],
    enabled: true,
    recipientType: "BUYER",
  },
};

// ─── Variable interpolation ─────────────────────────────────────────────────

function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? "");
}

// Interpolated variables (store names, buyer names, referral codes) come
// from real user-editable fields, not fixed template text — wrapEmailHtml
// embeds them in raw HTML, so they must be escaped there or a store/buyer
// name containing HTML would inject into an email sent to someone else.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Simple HTML wrapper for communication emails ───────────────────────────

function wrapEmailHtml(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; padding: 40px 20px;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <h2 style="color: #111827; margin: 0 0 16px;">${safeTitle}</h2>
    <p style="color: #374151; line-height: 1.6;">${safeBody}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="font-size: 12px; color: #9ca3af; text-align: center;">Eki Marketplace</p>
  </div>
</body>
</html>`.trim();
}

// ─── Logging ────────────────────────────────────────────────────────────────

async function logCommunication(params: {
  recipientId: string;
  recipientType: string;
  eventKey: string;
  channel: string;
  title: string;
  body: string;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | undefined> {
  try {
    const row = await prisma.communicationLog.create({
      data: {
        recipientId: params.recipientId,
        recipientType: params.recipientType,
        eventKey: params.eventKey,
        channel: params.channel,
        title: params.title,
        body: params.body,
        status: params.status ?? "SENT",
        metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return row?.id;
  } catch (error) {
    logger.warn("Failed to log communication", {
      eventKey: params.eventKey,
      recipientId: params.recipientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** logCommunication + canonical message event for the real outcome of a send() channel attempt. */
async function logSendOutcome(params: Parameters<typeof logCommunication>[0], outcome: MessageOutcome): Promise<void> {
  const logId = await logCommunication(params);
  emitMessageEvent(outcome, {
    logId,
    recipientId: params.recipientId,
    channel: params.channel,
    eventKey: params.eventKey,
    detail: params.metadata?.error as string | undefined,
    source: "communication_send",
  });
}

// ─── Main send function ─────────────────────────────────────────────────────

interface SendParams {
  eventKey: string;
  recipientId: string;
  recipientEmail?: string;
  variables: Record<string, string>;
  notificationType?: NotificationType;
  /**
   * Threaded through to notificationsService.create()'s in_app write.
   * Callers that already created their own Notification for this exact
   * event (e.g. renewals.service.ts's direct enqueue() before calling
   * automationService.scheduleAutomation()) should pass the SAME dedupe
   * key here so this in_app write collides against it and is silently
   * skipped, instead of creating a second Notification + push for one
   * logical event.
   */
  dedupeKey?: string;
  /**
   * P0 fix (2026-09): entity ids (orderId, etc.) needed to deep-link a tap
   * on this notification to the right screen — merged into both the push
   * and in-app `data` payloads, alongside `type`/`eventKey`. Previously the
   * push payload was ONLY `{ type: eventKey }`, so the frontend's tap
   * router had no id to route with even for the events it did recognize,
   * and several event keys (vendor verification, first order, buyer order
   * confirmed/shipped/delivered) weren't recognized there at all — every
   * one of those pushes was a dead tap.
   */
  data?: Record<string, unknown>;
}

/**
 * Real outcome of a send() call, distinct from "did the promise resolve
 * without throwing" (which was always true, even when nothing was actually
 * delivered). A caller that only checked "did send() throw" — as
 * automationService.scheduleAutomation() used to — could not tell a
 * genuinely delivered communication from one silently skipped because its
 * template was disabled, or one where every channel actually failed.
 */
export type SendOutcome = "SENT" | "SUPPRESSED" | "FAILED";
export interface SendResult {
  outcome: SendOutcome;
  reason?: string;
}

async function resolveTemplate(eventKey: string): Promise<CommunicationTemplate | null> {
  try {
    const dbTemplate = await prisma.communicationTemplate.findUnique({ where: { key: eventKey } });
    if (dbTemplate) {
      return {
        key: dbTemplate.key,
        title: dbTemplate.title,
        body: dbTemplate.body,
        channels: dbTemplate.channels as CommunicationTemplate["channels"],
        enabled: dbTemplate.enabled,
        recipientType: dbTemplate.recipientType as "BUYER" | "VENDOR",
      };
    }
  } catch {
    // DB unavailable — fall through to hardcoded
  }
  return TEMPLATES[eventKey] ?? null;
}

export const communicationService = {
  async send(params: SendParams): Promise<SendResult> {
    // Emergency pause (handbook 6.3): only automated/marketing sends are
    // paused — transactional events (order, payment, verification) never are.
    if (params.eventKey.startsWith("automation_") && (await commsPauseService.isAutomationsPaused())) {
      logger.info("Communication suppressed: emergency_pause", { eventKey: params.eventKey });
      return { outcome: "SUPPRESSED", reason: PAUSE_REASON };
    }

    const template = await resolveTemplate(params.eventKey);
    if (!template || !template.enabled) {
      logger.info("Communication skipped: template disabled or not found", { eventKey: params.eventKey });
      return { outcome: "SUPPRESSED", reason: `Template "${params.eventKey}" is disabled or does not exist` };
    }

    // NOTIF-DUP-01 fix: a caller that already wrote its own Notification row
    // for this exact event (passing dedupeKey — e.g. renewals.service.ts's
    // RENEWAL_REMINDER/PRICE_APPROVAL_REMINDER, which call
    // notificationsService.enqueue() directly with this SAME key before
    // scheduling the matching automation) previously still got a second,
    // genuinely duplicate push here — the in_app channel below already
    // collides safely against that row via the DB-level dedupeKey unique
    // constraint, but the push channel fired unconditionally regardless of
    // that outcome. Checking up front, before any channel is attempted,
    // means every channel (not just in_app) correctly treats this as
    // already-delivered. Only activates when a caller actually supplies a
    // dedupeKey for an in_app-carrying template — every other call site in
    // this codebase passes no dedupeKey at all and is completely unaffected.
    if (params.dedupeKey && template.channels.includes("in_app")) {
      const alreadyDelivered = await prisma.notification.findUnique({
        where: { dedupeKey: params.dedupeKey },
        select: { id: true },
      });
      if (alreadyDelivered) {
        logger.info("Communication skipped: dedupeKey already delivered by another writer", {
          eventKey: params.eventKey,
          dedupeKey: params.dedupeKey,
        });
        return { outcome: "SENT" };
      }
    }

    const title = interpolate(template.title, params.variables);
    const body = interpolate(template.body, params.variables);

    // Each channel resolves to whether it actually dispatched — never
    // rejects — so send() can report a real aggregate outcome instead of
    // just "the promise didn't throw" (which was always true).
    const promises: Promise<boolean>[] = [];
    let attemptedAnyChannel = false;

    for (const channel of template.channels) {
      switch (channel) {
        case "email":
          if (params.recipientEmail) {
            attemptedAnyChannel = true;
            const html = wrapEmailHtml(title, body);
            promises.push(
              enqueueEmail({ to: params.recipientEmail, subject: title, html })
                .then(() => logSendOutcome({
                  recipientId: params.recipientId,
                  recipientType: template.recipientType,
                  eventKey: params.eventKey,
                  channel: "email",
                  title,
                  body,
                  status: "QUEUED",
                }, "queued").then(() => true))
                .catch((err) => {
                  logger.warn("Communication email failed", { eventKey: params.eventKey, error: String(err) });
                  return logSendOutcome({
                    recipientId: params.recipientId,
                    recipientType: template.recipientType,
                    eventKey: params.eventKey,
                    channel: "email",
                    title,
                    body,
                    status: "FAILED",
                    metadata: { error: String(err) },
                  }, "failed").then(() => false);
                }),
            );
          }
          break;

        case "push":
          attemptedAnyChannel = true;
          promises.push(
            sendPushToUser(params.recipientId, { title, body, data: { type: params.eventKey, ...params.data } })
              .then(() => logSendOutcome({
                recipientId: params.recipientId,
                recipientType: template.recipientType,
                eventKey: params.eventKey,
                channel: "push",
                title,
                body,
              }, "queued").then(() => true))
              .catch((err) => {
                logger.warn("Communication push failed", { eventKey: params.eventKey, error: String(err) });
                return logSendOutcome({
                  recipientId: params.recipientId,
                  recipientType: template.recipientType,
                  eventKey: params.eventKey,
                  channel: "push",
                  title,
                  body,
                  status: "FAILED",
                }, "failed").then(() => false);
              }),
          );
          break;

        case "in_app":
          attemptedAnyChannel = true;
          promises.push(
            notificationsService.create({
              userId: params.recipientId,
              type: params.notificationType ?? ("ADMIN_BROADCAST" as NotificationType),
              title,
              body,
              data: { eventKey: params.eventKey, ...params.data },
              dedupeKey: params.dedupeKey,
            })
              .then((created) => logSendOutcome({
                recipientId: params.recipientId,
                recipientType: template.recipientType,
                eventKey: params.eventKey,
                channel: "in_app",
                title,
                body,
                // created === null means a Notification already existed
                // under this exact dedupeKey (e.g. a caller like
                // renewals.service.ts already created it directly) — the
                // recipient IS notified, just not by this write, so this
                // still counts as delivered, not failed.
              }, "delivered").then(() => true))
              .catch((err) => {
                logger.warn("Communication in-app failed", { eventKey: params.eventKey, error: String(err) });
                return logSendOutcome({
                  recipientId: params.recipientId,
                  recipientType: template.recipientType,
                  eventKey: params.eventKey,
                  channel: "in_app",
                  title,
                  body,
                  status: "FAILED",
                }, "failed").then(() => false);
              }),
          );
          break;
      }
    }

    if (!attemptedAnyChannel) {
      // Every configured channel was structurally skippable (e.g. the only
      // channel was "email" and the caller had no recipientEmail) — nothing
      // was ever attempted, which is a suppression, not a silent success.
      return { outcome: "SUPPRESSED", reason: "No eligible channel to dispatch on (e.g. no recipient email for an email-only template)" };
    }

    const results = await Promise.allSettled(promises);
    const anyDelivered = results.some((r) => r.status === "fulfilled" && r.value === true);
    if (anyDelivered) return { outcome: "SENT" };
    return { outcome: "FAILED", reason: "Every channel failed to dispatch" };
  },

  logOnly: logCommunication,

  async getTemplates(): Promise<CommunicationTemplate[]> {
    try {
      const dbTemplates = await prisma.communicationTemplate.findMany({ orderBy: { key: "asc" } });
      if (dbTemplates.length > 0) {
        return dbTemplates.map((t) => ({
          key: t.key,
          title: t.title,
          body: t.body,
          channels: t.channels as CommunicationTemplate["channels"],
          enabled: t.enabled,
          recipientType: t.recipientType as "BUYER" | "VENDOR",
        }));
      }
    } catch {
      // fallback
    }
    return Object.values(TEMPLATES);
  },

  async seedTemplates(): Promise<number> {
    let seeded = 0;
    for (const tmpl of Object.values(TEMPLATES)) {
      const existing = await prisma.communicationTemplate.findUnique({ where: { key: tmpl.key } });
      if (!existing) {
        await prisma.communicationTemplate.create({
          data: {
            key: tmpl.key,
            title: tmpl.title,
            body: tmpl.body,
            channels: tmpl.channels,
            recipientType: tmpl.recipientType,
            enabled: tmpl.enabled,
          },
        });
        seeded++;
      }
    }
    return seeded;
  },

  /**
   * Updates a template and records an immutable version snapshot (the first edit
   * also snapshots the pre-edit baseline as v1) plus an audit entry.
   */
  async updateTemplate(
    key: string,
    data: { title?: string; body?: string; channels?: string[]; enabled?: boolean },
    actor?: { id: string; reason?: string; request?: Request },
  ): Promise<CommunicationTemplate> {
    if (data.channels !== undefined) {
      const bad = data.channels.filter((c) => !["email", "push", "in_app"].includes(c));
      if (bad.length > 0 || data.channels.length === 0) throw new AppError("channels must be a non-empty subset of email, push, in_app", 400);
    }
    if (data.title !== undefined && !data.title.trim()) throw new AppError("title cannot be empty", 400);
    if (data.body !== undefined && !data.body.trim()) throw new AppError("body cannot be empty", 400);

    const before = await prisma.communicationTemplate.findUnique({ where: { key } });
    if (!before) throw new AppError("Template not found", 404);

    const updated = await prisma.$transaction(async (tx) => {
      const latest = await tx.communicationTemplateVersion.findFirst({ where: { templateKey: key }, orderBy: { version: "desc" } });
      let version = latest?.version ?? 0;
      if (!latest) {
        version = 1;
        await tx.communicationTemplateVersion.create({
          data: {
            templateKey: key, version, title: before.title, body: before.body, channels: before.channels,
            enabled: before.enabled, changedById: null, reason: "Baseline before first versioned edit",
          },
        });
      }
      const next = await tx.communicationTemplate.update({
        where: { key },
        data: {
          ...(data.title !== undefined && { title: data.title.trim() }),
          ...(data.body !== undefined && { body: data.body }),
          ...(data.channels !== undefined && { channels: data.channels }),
          ...(data.enabled !== undefined && { enabled: data.enabled }),
        },
      });
      await tx.communicationTemplateVersion.create({
        data: {
          templateKey: key, version: version + 1, title: next.title, body: next.body, channels: next.channels,
          enabled: next.enabled, changedById: actor?.id ?? null, reason: actor?.reason ?? null,
        },
      });
      return next;
    });

    if (actor) {
      await recordAudit({
        actorId: actor.id,
        action: "communication_template.updated",
        entityType: "CommunicationTemplate",
        entityId: updated.id,
        beforeState: { key, title: before.title, body: before.body, channels: before.channels, enabled: before.enabled },
        afterState: { key, title: updated.title, body: updated.body, channels: updated.channels, enabled: updated.enabled },
        reason: actor.reason,
        request: actor.request,
      });
    }
    return {
      key: updated.key,
      title: updated.title,
      body: updated.body,
      channels: updated.channels as CommunicationTemplate["channels"],
      enabled: updated.enabled,
      recipientType: updated.recipientType as "BUYER" | "VENDOR",
    };
  },

  async getTemplateVersions(key: string) {
    const versions = await prisma.communicationTemplateVersion.findMany({
      where: { templateKey: key },
      orderBy: { version: "desc" },
      take: 50,
    });
    const ids = [...new Set(versions.map((v) => v.changedById).filter((x): x is string => !!x))];
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return versions.map((v) => ({ ...v, changedBy: v.changedById ? byId.get(v.changedById) ?? null : null }));
  },

  async getStats() {
    // "Last 30 Days" per the admin dashboard label this feeds.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const since = { createdAt: { gte: thirtyDaysAgo } };
    const [totalSent, totalFailed, totalQueued, total, byEvent, byChannel] = await Promise.all([
      prisma.communicationLog.count({ where: { status: { in: ["SENT", "DELIVERED"] }, ...since } }),
      prisma.communicationLog.count({ where: { status: "FAILED", ...since } }),
      prisma.communicationLog.count({ where: { status: "QUEUED", ...since } }),
      prisma.communicationLog.count({ where: since }),
      prisma.communicationLog.groupBy({ by: ["eventKey"], where: since, _count: { id: true } }),
      prisma.communicationLog.groupBy({ by: ["channel"], where: since, _count: { id: true } }),
    ]);
    return {
      total,
      totalSent,
      totalFailed,
      totalQueued,
      byEvent: byEvent.map((e) => ({ event: e.eventKey, count: e._count.id })),
      byChannel: byChannel.map((c) => ({ channel: c.channel, count: c._count.id })),
    };
  },

  async listLogs(query: {
    eventKey?: string;
    recipientType?: string;
    status?: string;
    broadcastId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: any[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (query.eventKey) where.eventKey = query.eventKey;
    if (query.recipientType) where.recipientType = query.recipientType;
    if (query.status) where.status = query.status;
    if (query.broadcastId) where.broadcastId = query.broadcastId;

    const limit = Math.min(query.limit ?? 50, 100);
    const skip = query.offset ?? 0;

    const [items, total] = await Promise.all([
      prisma.communicationLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
      }),
      prisma.communicationLog.count({ where }),
    ]);

    return { items, total };
  },
};
