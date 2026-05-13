import { Worker, type Job } from "bullmq";

import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import {
  NOTIFICATION_JOB,
  notificationsService,
  type CreateNotificationInput,
} from "../modules/notifications/notifications.service";
import { QUEUE_NAMES } from "./index";

// Long-lived process. Run with:  tsx src/queues/notifications.worker.ts
// (or after build:  node dist/src/queues/notifications.worker.js).
// Cannot run inside a Vercel serverless function — deploy as a separate
// service (Railway, Render, Fly, a VM, etc.).

export function startNotificationsWorker(): Worker | null {
  const connection = getRedisConnection();
  if (!connection) {
    logger.warn("Notifications worker not started: REDIS_URL not configured");
    return null;
  }

  const worker = new Worker<CreateNotificationInput>(
    QUEUE_NAMES.notifications,
    async (job: Job<CreateNotificationInput>) => {
      if (job.name !== NOTIFICATION_JOB) {
        logger.warn("Unknown notification job name", { name: job.name, jobId: job.id });
        return;
      }
      await notificationsService.create(job.data);
    },
    { connection, concurrency: 5 },
  );

  worker.on("failed", (job, error) => {
    logger.error("Notification job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      errorMessage: error.message,
    });
  });
  worker.on("completed", (job) => {
    logger.debug("Notification job completed", { jobId: job.id });
  });

  logger.info("Notifications worker started", { queue: QUEUE_NAMES.notifications });
  return worker;
}

// Allow running this file directly as a standalone process.
if (require.main === module) {
  startNotificationsWorker();
}
