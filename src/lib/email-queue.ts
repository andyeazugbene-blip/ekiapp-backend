import { emailsQueue } from "../queues";
import { sendEmail } from "./email";
import { logger } from "./logger";
import type { SendEmailInput } from "./email";

/**
 * Enqueue an email for async delivery via BullMQ.
 * Falls back to direct send if Redis/queue is unavailable.
 * Never throws.
 */
export async function enqueueEmail(input: SendEmailInput): Promise<void> {
  if (emailsQueue) {
    try {
      await emailsQueue.add("send-email", input);
      return;
    } catch (error) {
      logger.warn("Email enqueue failed, falling back to direct send", {
        to: input.to,
        subject: input.subject,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fallback: send directly (non-blocking)
  sendEmail(input).catch((error) => {
    logger.error("Direct email send failed", {
      to: input.to,
      subject: input.subject,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  });
}
