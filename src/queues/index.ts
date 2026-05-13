import { Queue } from "bullmq";

import { logger } from "../lib/logger";
import { getRedisConnection, isRedisEnabled } from "../lib/redis";

// Queue foundation. Workers and producers will be wired up in later
// changes. For now we only declare the queues so the rest of the
// codebase can import stable symbols. If REDIS_URL is unset every
// export is `null` and callers must handle that case.

export const QUEUE_NAMES = {
  notifications: "notifications",
  emails: "emails",
  payouts: "payouts",
} as const;

function createQueue(name: string): Queue | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  try {
    return new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
  } catch (error) {
    logger.warn("Queue initialization failed", {
      queue: name,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const notificationsQueue: Queue | null = createQueue(QUEUE_NAMES.notifications);
export const emailsQueue: Queue | null = createQueue(QUEUE_NAMES.emails);
export const payoutQueue: Queue | null = createQueue(QUEUE_NAMES.payouts);

export function isQueueingEnabled(): boolean {
  return isRedisEnabled() && notificationsQueue !== null;
}
