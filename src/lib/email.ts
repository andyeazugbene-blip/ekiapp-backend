import { Resend } from "resend";

import { logger } from "./logger";

// Resend email client. If RESEND_API_KEY is unset, emails are logged
// but not sent (safe for local dev).

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.EMAIL_FROM ?? "Eki <noreply@culinarytales.app>";

let resend: Resend | null = null;

if (apiKey) {
  resend = new Resend(apiKey);
  logger.info("Resend email client initialized");
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send an email via Resend. Falls back to logging in dev.
 * Never throws — email failures must not break the calling operation.
 */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  if (!resend) {
    logger.info("Email (dev mode, not sent)", {
      to: input.to,
      subject: input.subject,
    });
    return true;
  }

  try {
    const result = await resend.emails.send({
      from: fromAddress,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });

    if (result.error) {
      logger.error("Resend email failed", {
        to: input.to,
        subject: input.subject,
        error: result.error.message,
      });
      return false;
    }

    logger.info("Email sent", { to: input.to, subject: input.subject, id: result.data?.id });
    return true;
  } catch (error) {
    logger.error("Email send exception", {
      to: input.to,
      subject: input.subject,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function isEmailEnabled(): boolean {
  return resend !== null;
}
