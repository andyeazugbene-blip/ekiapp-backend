import { Router } from "express";
import type { Request, Response } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../shared/utils/async-handler";
import { verifyUnsubscribeToken } from "./comms-utils";
import { eventsService, EVENT_NAMES } from "../events/events.service";

export const unsubscribeRouter = Router();

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;padding:48px 20px;"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.1);">
<h2 style="color:#111827;margin:0 0 12px;">${title}</h2><p style="color:#374151;line-height:1.6;">${message}</p></div></body></html>`;
}

/**
 * Clears marketing consent for the user identified by the signed token. Used by
 * the unsubscribe link and the RFC 8058 one-click List-Unsubscribe POST.
 * Transactional messages are unaffected.
 */
export async function handleUnsubscribe(request: Request, response: Response): Promise<void> {
  const token = (typeof request.query.token === "string" ? request.query.token : undefined)
    ?? (typeof request.body?.token === "string" ? request.body.token : undefined) ?? "";
  const userId = verifyUnsubscribeToken(token);
  if (!userId) {
    response.status(400).type("html").send(page("Invalid link", "This unsubscribe link is not valid or has been altered."));
    return;
  }
  const cleared = await prisma.user.updateMany({ where: { id: userId, marketingConsentAt: { not: null } }, data: { marketingConsentAt: null } });
  // Only the request that actually withdrew consent emits (count === 1); repeat clicks are no-ops.
  if (cleared.count === 1) {
    eventsService.emit({ name: EVENT_NAMES.message_opted_out, actorType: "user", actorId: userId, entityType: "User", entityId: userId, source: "unsubscribe_link", payload: { channel: "marketing" } });
  }
  logger.info("Marketing consent cleared via unsubscribe link", { userId });
  response.status(200).type("html").send(page("You are unsubscribed", "You will no longer receive marketing messages from Eki. You will still receive important messages about your orders and account."));
}

unsubscribeRouter.get("/", asyncHandler(handleUnsubscribe));
unsubscribeRouter.post("/", asyncHandler(handleUnsubscribe));
