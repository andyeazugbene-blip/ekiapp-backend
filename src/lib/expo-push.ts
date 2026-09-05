import crypto from "crypto";

import { logger } from "./logger";
import { prisma } from "./prisma";

// Expo Push API endpoints
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

// Expo recommends waiting before checking receipts — APNs/FCM need time to
// actually attempt delivery. Checking too soon just gets "not available yet".
const RECEIPT_CHECK_DELAY_MS = 5 * 60 * 1000;
// Expo's own documented cap on ids per getReceipts call.
const RECEIPT_BATCH_SIZE = 1000;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  channelId?: string;
  categoryId?: string;
  priority?: "default" | "normal" | "high";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushReceipt {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

/** Non-reversible reference for logs — never the real token (architecture requirement: no raw push tokens in production logs). */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Send push notifications via Expo Push API.
 * Never throws — push failures must not break the calling operation.
 *
 * `context[i]` (if provided) identifies which user/token produced
 * `messages[i]`, purely so a successful ticket can be persisted for a later
 * receipt check (see checkPushReceipts) — Expo accepting a message into its
 * queue (ticket status "ok") is NOT proof APNs/FCM actually delivered it;
 * real delivery failures (bad credentials, expired token, rate limits)
 * surface only in the receipt, fetched separately after a delay.
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  context?: { userId: string }[],
): Promise<void> {
  if (messages.length === 0) return;

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn("Expo Push API returned non-200", {
        status: response.status,
        body: body.slice(0, 500),
      });
      return;
    }

    const result = await response.json() as { data?: ExpoPushTicket[]; errors?: unknown[] };

    if (!result.data || !Array.isArray(result.data)) {
      logger.warn("Expo Push API returned unexpected format", {
        body: JSON.stringify(result).slice(0, 500),
      });
      return;
    }

    const ticketsToTrack: { ticketId: string; token: string; userId: string }[] = [];

    for (let i = 0; i < result.data.length; i++) {
      const ticket = result.data[i];
      const token = messages[i]?.to;
      if (ticket.status === "error") {
        const errorCode = ticket.details?.error ?? ticket.message ?? "unknown";
        if (errorCode === "DeviceNotRegistered") {
          await prisma.pushToken.deleteMany({ where: { token } }).catch(() => {});
          logger.info("Removed invalid push token (DeviceNotRegistered, from ticket)", { tokenHash: hashToken(token) });
        } else {
          // A ticket-level error other than DeviceNotRegistered — genuinely
          // rare (Expo usually only rejects malformed requests here), but
          // classified and logged rather than silently dropped.
          logger.warn("Expo push ticket error (non-fatal)", {
            error: errorCode,
            message: ticket.message,
            tokenHash: token ? hashToken(token) : undefined,
          });
        }
      } else if (ticket.status === "ok" && ticket.id && token) {
        const userId = context?.[i]?.userId;
        if (userId) ticketsToTrack.push({ ticketId: ticket.id, token, userId });
      }
    }

    if (ticketsToTrack.length > 0) {
      await prisma.pushTicket.createMany({ data: ticketsToTrack, skipDuplicates: true }).catch((error) => {
        logger.warn("Failed to persist push tickets for receipt checking", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    logger.warn("Expo Push send failed", {
      messageCount: messages.length,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fetches real Expo push RECEIPTS for tickets that were accepted ("ok") at
 * least RECEIPT_CHECK_DELAY_MS ago. A ticket status of "ok" only means Expo
 * queued the request — this is the only way to find out whether APNs/FCM
 * actually accepted/delivered it, or rejected it for a reason like
 * InvalidCredentials, MessageTooBig, MessageRateExceeded, or
 * MismatchSenderId (all logged, classified, for real diagnosis instead of
 * flying blind on ticket status alone). DeviceNotRegistered found here
 * (as opposed to at ticket time) still gets the token removed — some
 * invalid-token cases only surface at the receipt stage.
 */
export async function checkPushReceipts(): Promise<{ checked: number; invalidated: number; errors: number }> {
  const cutoff = new Date(Date.now() - RECEIPT_CHECK_DELAY_MS);
  const pending = await prisma.pushTicket.findMany({
    where: { createdAt: { lte: cutoff } },
    take: RECEIPT_BATCH_SIZE,
  });

  if (pending.length === 0) return { checked: 0, invalidated: 0, errors: 0 };

  let invalidated = 0;
  let errors = 0;

  try {
    const response = await fetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ ids: pending.map((p) => p.ticketId) }),
    });

    if (response.ok) {
      const result = await response.json() as { data?: Record<string, ExpoPushReceipt> };
      for (const ticket of pending) {
        const receipt = result.data?.[ticket.ticketId];
        if (!receipt || receipt.status !== "error") continue;

        const errorCode = receipt.details?.error ?? receipt.message ?? "unknown";
        if (errorCode === "DeviceNotRegistered") {
          await prisma.pushToken.deleteMany({ where: { token: ticket.token } }).catch(() => {});
          invalidated++;
        } else {
          errors++;
          // Real, classified delivery failure — this is exactly the class
          // of problem a ticket-only check can never reveal (e.g. a wrong/
          // expired APNs credential shows up here, not at ticket time).
          logger.warn("Expo push receipt error", {
            error: errorCode,
            message: receipt.message,
            ticketId: ticket.ticketId,
            userId: ticket.userId,
            tokenHash: hashToken(ticket.token),
          });
        }
      }
    } else {
      logger.warn("Expo getReceipts returned non-200", { status: response.status });
    }
  } catch (error) {
    logger.warn("Expo getReceipts failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  await prisma.pushTicket.deleteMany({ where: { id: { in: pending.map((p) => p.id) } } });

  return { checked: pending.length, invalidated, errors };
}

/**
 * Send a push notification to all devices of a user.
 * Loads tokens from DB, sends via Expo, never throws.
 * channelId maps to Android notification channels (default, orders, payouts, messages).
 */
export async function sendPushToUser(
  userId: string,
  notification: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  try {
    const tokens = await prisma.pushToken.findMany({
      where: { userId },
      select: { token: true },
    });

    if (tokens.length === 0) {
      logger.info("Push skipped: no push tokens for user", { userId });
      return;
    }

    // Map notification type to channel (Android) and category (iOS)
    const rawType = notification.data?.type;
    const channelId =
      typeof rawType === "string" && rawType.includes("payout") ? "payouts"
      : typeof rawType === "string" && rawType.includes("message") ? "messages"
      : typeof rawType === "string" && (rawType.includes("order") || rawType.includes("new_order")) ? "orders"
      : "default";

    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.token,
      title: notification.title,
      body: notification.body,
      data: notification.data,
      sound: "default",
      channelId,
      categoryId: channelId,      // iOS category (same names as channels)
      priority: "high",           // Deliver immediately, critical for serverless
    }));

    await sendExpoPush(messages, tokens.map(() => ({ userId })));
  } catch (error) {
    logger.warn("sendPushToUser failed", {
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
