import crypto from "crypto";

import { logger } from "./logger";
import { prisma } from "./prisma";

// Expo Push API endpoints
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/**
 * Optional Expo access token (expo.dev → account settings → access tokens).
 * Every send/receipt call this module has ever made has gone out with no
 * Authorization header at all — Expo's push API accepts that (the token
 * itself is what ties a request to a project, not this header), so real
 * pushes have still been able to reach APNs/FCM. But Expo's own docs
 * describe this header as how a send gets attributed to a specific
 * expo.dev account/project — its absence is the most likely reason the
 * project's "Push notifications sent" dashboard can show no data even
 * while real sends succeed. Optional and backward compatible: unset, this
 * changes nothing about how sends behave.
 */
function expoAuthHeaders(): Record<string, string> {
  const token = process.env.EXPO_ACCESS_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
export interface ExpoSendOutcome {
  /** Tickets Expo accepted (handed to Expo, NOT yet proof of APNs/FCM delivery). */
  accepted: number;
  /** Tickets (or whole requests) Expo rejected. */
  rejected: number;
  /** First error code/message, for diagnosis and CommunicationLog.statusDetail. */
  error?: string;
  /** Expo ticket ids that were accepted. */
  ticketIds: string[];
}

export async function sendExpoPush(
  messages: ExpoPushMessage[],
  context?: { userId: string; logId?: string }[],
): Promise<void> {
  await sendExpoPushDetailed(messages, context);
}

/** Same as sendExpoPush but reports what Expo actually did with the messages. */
export async function sendExpoPushDetailed(
  messages: ExpoPushMessage[],
  context?: { userId: string; logId?: string }[],
): Promise<ExpoSendOutcome> {
  const outcome: ExpoSendOutcome = { accepted: 0, rejected: 0, ticketIds: [] };
  if (messages.length === 0) return outcome;

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...expoAuthHeaders(),
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn("Expo Push API returned non-200", {
        status: response.status,
        body: body.slice(0, 500),
      });
      return { ...outcome, rejected: messages.length, error: `expo_http_${response.status}` };
    }

    const result = await response.json() as { data?: ExpoPushTicket[]; errors?: unknown[] };

    if (!result.data || !Array.isArray(result.data)) {
      logger.warn("Expo Push API returned unexpected format", {
        body: JSON.stringify(result).slice(0, 500),
      });
      return { ...outcome, rejected: messages.length, error: "expo_unexpected_response" };
    }

    const ticketsToTrack: { ticketId: string; token: string; userId: string; logId?: string }[] = [];

    for (let i = 0; i < result.data.length; i++) {
      const ticket = result.data[i];
      const token = messages[i]?.to;
      if (ticket.status === "error") {
        const errorCode = ticket.details?.error ?? ticket.message ?? "unknown";
        outcome.rejected++;
        outcome.error = outcome.error ?? errorCode;
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
        outcome.accepted++;
        outcome.ticketIds.push(ticket.id);
        const userId = context?.[i]?.userId;
        const logId = context?.[i]?.logId;
        if (userId) ticketsToTrack.push({ ticketId: ticket.id, token, userId, ...(logId ? { logId } : {}) });
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
    return { ...outcome, rejected: messages.length, error: "expo_unreachable" };
  }
  return outcome;
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
export async function checkPushReceipts(
  opts: { logIds?: string[]; ignoreDelay?: boolean } = {},
): Promise<{ checked: number; invalidated: number; errors: number }> {
  const cutoff = new Date(Date.now() - (opts.ignoreDelay ? 0 : RECEIPT_CHECK_DELAY_MS));
  const pending = await prisma.pushTicket.findMany({
    where: {
      createdAt: { lte: cutoff },
      ...(opts.logIds ? { logId: { in: opts.logIds } } : {}),
    },
    take: RECEIPT_BATCH_SIZE,
  });

  if (pending.length === 0) return { checked: 0, invalidated: 0, errors: 0 };

  let invalidated = 0;
  let errors = 0;
  // Tickets whose receipt was actually returned by Expo (or are too old to
  // ever get one) are resolved and removed; the rest are kept for the next pass
  // so an unreachable/late receipts API never silently loses delivery truth.
  const resolvedIds: string[] = [];
  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;

  try {
    const response = await fetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...expoAuthHeaders(),
      },
      body: JSON.stringify({ ids: pending.map((p) => p.ticketId) }),
    });

    if (response.ok) {
      const result = await response.json() as { data?: Record<string, ExpoPushReceipt> };
      for (const ticket of pending) {
        const receipt = result.data?.[ticket.ticketId];
        if (!receipt) {
          if (ticket.createdAt.getTime() < staleCutoff) {
            resolvedIds.push(ticket.id);
            if (ticket.logId) await markLog(ticket.logId, "FAILED", "no_receipt_after_24h");
          }
          continue;
        }
        resolvedIds.push(ticket.id);

        if (receipt.status !== "error") {
          // Receipt ok = APNs/FCM accepted the message (provider-level delivery).
          if (ticket.logId) await markLog(ticket.logId, "DELIVERED", "provider_receipt_ok");
          continue;
        }

        const errorCode = receipt.details?.error ?? receipt.message ?? "unknown";
        if (ticket.logId) await markLog(ticket.logId, "FAILED", errorCode);
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

  if (resolvedIds.length > 0) {
    await prisma.pushTicket.deleteMany({ where: { id: { in: resolvedIds } } });
  }

  return { checked: pending.length, invalidated, errors };
}

/**
 * Records the real provider outcome on a broadcast's per-recipient
 * CommunicationLog row. Never throws.
 */
async function markLog(logId: string, status: "DELIVERED" | "FAILED", detail: string): Promise<void> {
  try {
    // DELIVERED wins: a user with two devices where one receipt is OK is delivered.
    await prisma.communicationLog.updateMany({
      where: status === "DELIVERED" ? { id: logId } : { id: logId, status: { not: "DELIVERED" } },
      data: { status, statusDetail: detail, ...(status === "DELIVERED" ? { deliveredAt: new Date() } : {}) },
    });
  } catch (error) {
    logger.warn("Could not record push receipt on communication log", {
      logId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Send a push notification to all devices of a user.
 * Loads tokens from DB, sends via Expo, never throws.
 * channelId maps to Android notification channels (default, orders, payouts, messages).
 */
export interface PushSendResult {
  /** Devices (tokens) the user has registered. 0 => nothing could be sent. */
  tokens: number;
  /** Messages Expo accepted (handed to Expo). */
  accepted: number;
  rejected: number;
  error?: string;
  ticketIds: string[];
}

export async function sendPushToUser(
  userId: string,
  notification: { title: string; body: string; data?: Record<string, unknown> },
  opts: { logId?: string } = {},
): Promise<PushSendResult> {
  const result: PushSendResult = { tokens: 0, accepted: 0, rejected: 0, ticketIds: [] };
  try {
    const tokens = await prisma.pushToken.findMany({
      where: { userId },
      select: { token: true },
    });
    result.tokens = tokens.length;

    if (tokens.length === 0) {
      logger.info("Push skipped: no push tokens for user", { userId });
      return result;
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

    // One Expo request per token, not one batched request for all of the
    // user's tokens. Expo rejects an entire request with
    // PUSH_TOO_MANY_EXPERIENCE_IDS if it contains tokens from more than one
    // Expo project — which happens for real here: this app's EAS project
    // ownership changed multiple times (mouadchiali -> mouaduae ->
    // chialimouad), so a user who registered a device under an old build and
    // later reinstalled a current one can have tokens from two project
    // generations in the same PushToken rows. Batching them together meant
    // one stale/orphaned token silently zeroed out delivery to that user's
    // valid, current token too. Isolating per token contains the failure to
    // the one bad token (still cleaned up individually via its own ticket).
    const outcomes = await Promise.allSettled(
      messages.map((message) => sendExpoPushDetailed([message], [{ userId, ...(opts.logId ? { logId: opts.logId } : {}) }])),
    );
    for (const o of outcomes) {
      if (o.status !== "fulfilled") { result.rejected++; continue; }
      result.accepted += o.value.accepted;
      result.rejected += o.value.rejected;
      result.ticketIds.push(...o.value.ticketIds);
      if (o.value.error && !result.error) result.error = o.value.error;
    }
  } catch (error) {
    logger.warn("sendPushToUser failed", {
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    result.error = "push_exception";
  }
  return result;
}
