import { eventsService, EVENT_NAMES } from "../events/events.service";

/**
 * Canonical message lifecycle events (handbook 12) derived ONLY from outcomes
 * the platform really observes:
 *
 *  - message_queued    : the message was accepted by its provider/channel
 *                        (email accepted by the mail provider, push ticket
 *                        handed to Expo). No claim of end-user delivery.
 *  - message_delivered : an in-app notification was stored in the inbox, or a
 *                        real Expo push receipt reported OK.
 *  - message_failed    : the channel dispatch failed (or Expo reported failure).
 *
 * message_opened / message_clicked are NOT emitted: no open/click tracking
 * path exists. Delivery is at-least-once; payload.eventKey is stable per
 * (outcome, communication log row) so consumers dedupe. Never throws.
 */
export type MessageOutcome = "queued" | "delivered" | "failed";

const NAME: Record<MessageOutcome, string> = {
  queued: EVENT_NAMES.message_queued,
  delivered: EVENT_NAMES.message_delivered,
  failed: EVENT_NAMES.message_failed,
};

export function emitMessageEvent(
  outcome: MessageOutcome,
  p: { logId?: string | null; recipientId?: string | null; channel: string; eventKey?: string | null; broadcastId?: string | null; detail?: string | null; source: string },
): void {
  try {
    const name = NAME[outcome];
    eventsService.emit({
      name,
      actorType: "system",
      entityType: p.logId ? "CommunicationLog" : "User",
      entityId: p.logId ?? p.recipientId ?? null,
      secondaryEntities: { recipientId: p.recipientId ?? null, broadcastId: p.broadcastId ?? null },
      source: p.source,
      payload: {
        eventKey: p.logId ? `${name}:${p.logId}` : null,
        channel: p.channel,
        templateEventKey: p.eventKey ?? null,
        ...(outcome === "failed" && p.detail ? { reason: String(p.detail).slice(0, 200) } : {}),
      },
    });
  } catch {
    // telemetry must never affect a send
  }
}
