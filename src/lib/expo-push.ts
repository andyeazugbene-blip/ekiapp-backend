import { logger } from "./logger";
import { prisma } from "./prisma";

// Expo Push API endpoint
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  channelId?: string;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Send push notifications via Expo Push API.
 * Never throws — push failures must not break the calling operation.
 */
export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<void> {
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
      logger.warn("Expo Push API returned non-200", { status: response.status });
      return;
    }

    const result = await response.json() as { data: ExpoPushTicket[] };

    // Check for invalid tokens and remove them
    for (let i = 0; i < result.data.length; i++) {
      const ticket = result.data[i];
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        // Remove invalid token from DB
        const token = messages[i].to;
        await prisma.pushToken.deleteMany({ where: { token } }).catch(() => {});
        logger.info("Removed invalid push token (DeviceNotRegistered)");
      }
    }
  } catch (error) {
    logger.warn("Expo Push send failed", {
      messageCount: messages.length,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
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

    if (tokens.length === 0) return;

    // Map notification type to Android channel
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
    }));

    await sendExpoPush(messages);
  } catch (error) {
    logger.warn("sendPushToUser failed", {
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
