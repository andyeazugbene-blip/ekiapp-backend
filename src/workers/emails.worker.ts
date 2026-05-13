import { Worker, type Job } from "bullmq";

import { sendEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import { QUEUE_NAMES } from "../queues";

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

async function processEmail(job: Job<EmailJobData>): Promise<void> {
  const { to, subject, html, text } = job.data;

  const success = await sendEmail({ to, subject, html, text });

  if (!success) {
    throw new Error(`Failed to send email to ${to}: ${subject}`);
  }

  logger.info("Email job completed", { jobId: job.id, to, subject });
}

export function startEmailsWorker(): Worker | null {
  const connection = getRedisConnection();
  if (!connection) {
    logger.info("Emails worker skipped (no Redis)");
    return null;
  }

  const worker = new Worker(
    QUEUE_NAMES.emails,
    processEmail,
    {
      connection,
      concurrency: 3,
      limiter: {
        max: 10,
        duration: 1000, // 10 emails per second max (Resend rate limit)
      },
    },
  );

  worker.on("completed", (job) => {
    logger.debug("Email job completed", { jobId: job.id });
  });

  worker.on("failed", (job, error) => {
    logger.error("Email job failed", {
      jobId: job?.id,
      errorMessage: error.message,
      attempts: job?.attemptsMade,
    });
  });

  logger.info("Emails worker started");
  return worker;
}
