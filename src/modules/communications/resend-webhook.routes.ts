import crypto from "crypto";

import { Router } from "express";
import type { Request, Response } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../shared/utils/async-handler";
import { constantTimeEqual } from "../../shared/utils/crypto";
import { EVENT_NAMES, eventsService } from "../events/events.service";
import { emitMessageEvent } from "./message-events";

export const resendWebhookRouter = Router();

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** Resend signs webhooks with Svix: HMAC-SHA256 of "id.timestamp.body". */
export function verifyResendSignature(
  rawBody: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string,
  now = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > MAX_SIGNATURE_AGE_MS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  // The header can hold several space-separated signatures during secret rotation.
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && Boolean(value) && constantTimeEqual(value, expected);
  });
}

type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    tags?: Record<string, string> | { name: string; value: string }[];
    bounce?: { message?: string };
    failed?: { reason?: string };
  };
};

function logIdFromTags(tags: NonNullable<ResendEvent["data"]>["tags"]): string | undefined {
  if (!tags) return undefined;
  if (Array.isArray(tags)) return tags.find((tag) => tag.name === "log_id")?.value;
  return tags.log_id;
}

export async function applyResendEvent(event: ResendEvent): Promise<"applied" | "ignored"> {
  const logId = logIdFromTags(event.data?.tags);
  const emailId = event.data?.email_id;
  if (!logId && !emailId) return "ignored";
  const log = await prisma.communicationLog.findFirst({
    where: logId ? { id: logId } : { providerRef: emailId },
    select: { id: true, recipientId: true, eventKey: true, broadcastId: true },
  });
  if (!log) return "ignored";

  const at = event.created_at && !Number.isNaN(Date.parse(event.created_at)) ? new Date(event.created_at) : new Date();
  const message = { logId: log.id, recipientId: log.recipientId, channel: "email", eventKey: log.eventKey, broadcastId: log.broadcastId, source: "resend_webhook" };

  switch (event.type) {
    case "email.delivered": {
      const claim = await prisma.communicationLog.updateMany({
        where: { id: log.id, status: { in: ["QUEUED", "SENT"] } },
        data: { status: "DELIVERED", deliveredAt: at, ...(emailId ? { providerRef: emailId } : {}) },
      });
      if (claim.count > 0) emitMessageEvent("delivered", message);
      return "applied";
    }
    case "email.bounced":
    case "email.failed": {
      const detail = event.data?.bounce?.message ?? event.data?.failed?.reason ?? event.type;
      const claim = await prisma.communicationLog.updateMany({
        where: { id: log.id, status: { not: "FAILED" } },
        data: { status: "FAILED", statusDetail: detail.slice(0, 500) },
      });
      if (claim.count > 0) emitMessageEvent("failed", { ...message, detail });
      return "applied";
    }
    case "email.complained":
      await prisma.communicationLog.update({ where: { id: log.id }, data: { statusDetail: "The recipient marked this as spam" } });
      return "applied";
    case "email.opened": {
      const claim = await prisma.communicationLog.updateMany({ where: { id: log.id, openedAt: null }, data: { openedAt: at } });
      if (claim.count > 0) emitMessageEvent("opened", message);
      return "applied";
    }
    case "email.clicked": {
      const claim = await prisma.communicationLog.updateMany({ where: { id: log.id, clickedAt: null }, data: { clickedAt: at } });
      // A click proves an open, even if the tracking pixel was blocked.
      const opened = await prisma.communicationLog.updateMany({ where: { id: log.id, openedAt: null }, data: { openedAt: at } });
      if (opened.count > 0) emitMessageEvent("opened", message);
      if (claim.count > 0) {
        emitMessageEvent("clicked", message);
        if (log.eventKey.startsWith("automation_")) {
          eventsService.emit({
            name: EVENT_NAMES.automation_clicked, actorType: "user", actorId: log.recipientId,
            entityType: "CommunicationLog", entityId: log.id, source: "resend_webhook",
            payload: { eventKey: log.eventKey, channel: "email" },
          });
        }
      }
      return "applied";
    }
    default:
      return "ignored";
  }
}

export async function handleResendWebhook(request: Request, response: Response): Promise<void> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("Resend webhook received but RESEND_WEBHOOK_SECRET is not set");
    response.status(503).json({ error: "Webhook is not configured" });
    return;
  }
  const rawBody = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
  const valid = verifyResendSignature(rawBody, {
    id: request.header("svix-id") ?? undefined,
    timestamp: request.header("svix-timestamp") ?? undefined,
    signature: request.header("svix-signature") ?? undefined,
  }, secret);
  if (!valid) {
    response.status(400).json({ error: "Invalid signature" });
    return;
  }
  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    response.status(400).json({ error: "Invalid body" });
    return;
  }
  // A failure here returns 500, so Resend retries. Every update is safe to repeat.
  const result = await applyResendEvent(event);
  response.status(200).json({ received: true, result });
}

resendWebhookRouter.post("/webhook", asyncHandler(handleResendWebhook));
