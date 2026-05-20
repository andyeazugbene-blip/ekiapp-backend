import { Worker, type Job } from "bullmq";

import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getRedisConnection } from "../lib/redis";
import { QUEUE_NAMES } from "../queues";
import type { CreateNotificationInput } from "../modules/notifications/notifications.service";

async function processNotification(job: Job<CreateNotificationInput>): Promise<void> {
  const { userId, type, title, body, data } = job.data;

  await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body,
      data: data ?? undefined,
    },
  });

  logger.info("Notification created by worker", { jobId: job.id, type, userId });
}

export function startNotificationsWorker(): Worker | null {
  const connection = getRedisConnection();
  if (!connection) {
    logger.info("Notifications worker skipped (no Redis)");
    return null;
  }

  const worker = new Worker(
    QUEUE_NAMES.notifications,
    processNotification,
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on("completed", (job) => {
    logger.debug("Notification job completed", { jobId: job.id });
  });

  worker.on("failed", (job, error) => {
    logger.error("Notification job failed", {
      jobId: job?.id,
      errorMessage: error.message,
    });
  });

  logger.info("Notifications worker started");
  return worker;
}
