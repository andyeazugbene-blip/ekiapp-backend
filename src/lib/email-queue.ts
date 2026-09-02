import { emailsQueue } from "../queues";
import { sendEmail } from "./email";
import { logger } from "./logger";
import type { SendEmailInput } from "./email";

/**
 * Send an email directly (non-blocking) — never throws.
 *
 * Previously this enqueued to BullMQ's "emails" queue first and only sent
 * directly as a fallback if that failed. There is no worker anywhere in
 * this repo that ever processes the "emails" queue (unlike notifications,
 * which at least has a standalone-runnable notifications.worker.ts), so if
 * REDIS_URL were ever set in production every email — including password
 * resets and OTP codes — would have been silently queued and never sent.
 * Best-effort-enqueues afterwards purely so a future worker, if one is ever
 * written and deployed, has a record to consume; delivery never depends on it.
 */
export async function enqueueEmail(input: SendEmailInput): Promise<void> {
  sendEmail(input).catch((error) => {
    logger.error("Direct email send failed", {
      to: input.to,
      subject: input.subject,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  });

  if (emailsQueue) {
    emailsQueue.add("send-email", input).catch((error) => {
      logger.warn("Email best-effort enqueue failed (non-blocking)", {
        to: input.to,
        subject: input.subject,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
