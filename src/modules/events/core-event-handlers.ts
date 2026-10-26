import type { Event, Prisma } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { eventOutboxService } from "./event-outbox.service";
import { EVENT_NAMES } from "./events.service";

function requiredId(payload: unknown, field: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AppError("Invalid support response event payload", 400);
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim()) throw new AppError(`Missing support response ${field}`, 400);
  return value;
}

/**
 * R28 consumer for the real general SUPPORT conversation model. This only
 * materializes the in-app candidate. Outbox delivery and candidate creation
 * commit together; external push remains a post-commit delivery concern.
 */
export async function handleSupportResponseReceived(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const conversationId = requiredId(event.payload, "conversationId");
  const messageId = requiredId(event.payload, "messageId");
  const message = await tx.message.findUnique({
    where: { id: messageId },
    include: { conversation: { select: { id: true, type: true, status: true, participantA: true, participantB: true } } },
  });

  // The event is authoritative only while it still describes an unread,
  // customer-visible reply in an open general support thread.
  if (!message || message.conversationId !== conversationId || message.isInternal
    || message.conversation.type !== "SUPPORT"
    || message.conversation.status !== "OPEN" || message.readAt) return;

  const [sender, a, b] = await Promise.all([
    tx.user.findUnique({ where: { id: message.senderId }, select: { id: true, role: true } }),
    tx.user.findUnique({ where: { id: message.conversation.participantA }, select: { id: true, role: true } }),
    tx.user.findUnique({ where: { id: message.conversation.participantB }, select: { id: true, role: true } }),
  ]);
  if (sender?.role !== "ADMIN") return;
  const recipient = a?.role === "ADMIN" ? b : a;
  if (!recipient || recipient.role === "ADMIN") return;

  await notificationsService.create({
    userId: recipient.id,
    type: "NEW_MESSAGE",
    title: "Eki Support has replied",
    body: "Open your case to read the update.",
    data: {
      type: "support_response_received",
      destination: "support_conversation",
      conversationId,
      messageId,
    },
    dedupeKey: `R28_SUPPORT_THREAD_REPLY:${messageId}`,
  }, tx);
}

let registered = false;
export function registerCoreEventHandlers(): void {
  if (registered) return;
  eventOutboxService.registerHandler(EVENT_NAMES.support_response_received, handleSupportResponseReceived);
  registered = true;
}

