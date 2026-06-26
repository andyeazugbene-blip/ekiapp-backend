import type { NotificationType, Prisma } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { enqueueEmail } from "../../lib/email-queue";
import { sendPushToUser } from "../../lib/expo-push";
import { notificationsService } from "../notifications/notifications.service";

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

// ─── Simple HTML wrapper for communication emails ───────────────────────────

function wrapEmailHtml(title: string, body: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; padding: 40px 20px;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <h2 style="color: #111827; margin: 0 0 16px;">${title}</h2>
    <p style="color: #374151; line-height: 1.6;">${body}</p>
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
}): Promise<void> {
  try {
    await prisma.communicationLog.create({
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
  } catch (error) {
    logger.warn("Failed to log communication", {
      eventKey: params.eventKey,
      recipientId: params.recipientId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Main send function ─────────────────────────────────────────────────────

interface SendParams {
  eventKey: string;
  recipientId: string;
  recipientEmail?: string;
  variables: Record<string, string>;
  notificationType?: NotificationType;
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
  async send(params: SendParams): Promise<void> {
    const template = await resolveTemplate(params.eventKey);
    if (!template || !template.enabled) {
      logger.info("Communication skipped: template disabled or not found", { eventKey: params.eventKey });
      return;
    }

    const title = interpolate(template.title, params.variables);
    const body = interpolate(template.body, params.variables);

    const promises: Promise<void>[] = [];

    for (const channel of template.channels) {
      switch (channel) {
        case "email":
          if (params.recipientEmail) {
            const html = wrapEmailHtml(title, body);
            promises.push(
              enqueueEmail({ to: params.recipientEmail, subject: title, html })
                .then(() => logCommunication({
                  recipientId: params.recipientId,
                  recipientType: template.recipientType,
                  eventKey: params.eventKey,
                  channel: "email",
                  title,
                  body,
                  status: "QUEUED",
                }))
                .catch((err) => {
                  logger.warn("Communication email failed", { eventKey: params.eventKey, error: String(err) });
                  return logCommunication({
                    recipientId: params.recipientId,
                    recipientType: template.recipientType,
                    eventKey: params.eventKey,
                    channel: "email",
                    title,
                    body,
                    status: "FAILED",
                    metadata: { error: String(err) },
                  });
                }),
            );
          }
          break;

        case "push":
          promises.push(
            sendPushToUser(params.recipientId, { title, body, data: { type: params.eventKey } })
              .then(() => logCommunication({
                recipientId: params.recipientId,
                recipientType: template.recipientType,
                eventKey: params.eventKey,
                channel: "push",
                title,
                body,
              }))
              .catch((err) => {
                logger.warn("Communication push failed", { eventKey: params.eventKey, error: String(err) });
                return logCommunication({
                  recipientId: params.recipientId,
                  recipientType: template.recipientType,
                  eventKey: params.eventKey,
                  channel: "push",
                  title,
                  body,
                  status: "FAILED",
                });
              }),
          );
          break;

        case "in_app":
          promises.push(
            notificationsService.create({
              userId: params.recipientId,
              type: params.notificationType ?? ("ADMIN_BROADCAST" as NotificationType),
              title,
              body,
              data: { eventKey: params.eventKey },
            })
              .then(() => logCommunication({
                recipientId: params.recipientId,
                recipientType: template.recipientType,
                eventKey: params.eventKey,
                channel: "in_app",
                title,
                body,
              }))
              .catch((err) => {
                logger.warn("Communication in-app failed", { eventKey: params.eventKey, error: String(err) });
                return logCommunication({
                  recipientId: params.recipientId,
                  recipientType: template.recipientType,
                  eventKey: params.eventKey,
                  channel: "in_app",
                  title,
                  body,
                  status: "FAILED",
                });
              }),
          );
          break;
      }
    }

    await Promise.allSettled(promises);
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

  async updateTemplate(key: string, data: { title?: string; body?: string; channels?: string[]; enabled?: boolean }): Promise<CommunicationTemplate> {
    const updated = await prisma.communicationTemplate.update({
      where: { key },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.body !== undefined && { body: data.body }),
        ...(data.channels !== undefined && { channels: data.channels }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
      },
    });
    return {
      key: updated.key,
      title: updated.title,
      body: updated.body,
      channels: updated.channels as CommunicationTemplate["channels"],
      enabled: updated.enabled,
      recipientType: updated.recipientType as "BUYER" | "VENDOR",
    };
  },

  async getStats() {
    const [totalSent, totalFailed, totalQueued, total, byEvent, byChannel] = await Promise.all([
      prisma.communicationLog.count({ where: { status: "SENT" } }),
      prisma.communicationLog.count({ where: { status: "FAILED" } }),
      prisma.communicationLog.count({ where: { status: "QUEUED" } }),
      prisma.communicationLog.count(),
      prisma.communicationLog.groupBy({ by: ["eventKey"], _count: { id: true } }),
      prisma.communicationLog.groupBy({ by: ["channel"], _count: { id: true } }),
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
    limit?: number;
    offset?: number;
  }): Promise<{ items: any[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (query.eventKey) where.eventKey = query.eventKey;
    if (query.recipientType) where.recipientType = query.recipientType;
    if (query.status) where.status = query.status;

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
