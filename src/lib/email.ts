import { Resend } from "resend";

import { logger } from "./logger";

// Resend email client. If RESEND_API_KEY is unset the provider is NOT
// configured: in production sendEmail() reports failure (false) so callers can
// never claim an email was sent; in dev/test it logs and returns true so local
// flows (OTP, password reset) keep working without a provider.

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
  /** Extra headers, e.g. List-Unsubscribe for marketing mail. */
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  ok: boolean;
  /** Provider message id when the provider accepted the message. */
  id?: string;
  /** "not_configured" when no provider is configured (never reported as sent in production). */
  error?: string;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Send an email via Resend. Never throws. Returns a detailed result so
 * broadcast logging can record the real outcome.
 */
export async function sendEmailDetailed(input: SendEmailInput): Promise<SendEmailResult> {
  if (!resend) {
    if (isProduction()) {
      logger.error("Email NOT sent: no email provider configured (RESEND_API_KEY missing)", {
        to: input.to,
        subject: input.subject,
      });
      return { ok: false, error: "not_configured" };
    }
    logger.info("Email (dev mode, not sent)", { to: input.to, subject: input.subject });
    return { ok: true, id: "dev-not-sent" };
  }

  try {
    const result = await resend.emails.send({
      from: fromAddress,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
    });

    if (result.error) {
      logger.error("Resend email failed", {
        to: input.to,
        subject: input.subject,
        error: result.error.message,
      });
      return { ok: false, error: result.error.message };
    }

    logger.info("Email sent", { to: input.to, subject: input.subject, id: result.data?.id });
    return { ok: true, id: result.data?.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Email send exception", { to: input.to, subject: input.subject, errorMessage: message });
    return { ok: false, error: message };
  }
}

/** Boolean wrapper kept for existing callers. */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  return (await sendEmailDetailed(input)).ok;
}

export function isEmailEnabled(): boolean {
  return resend !== null;
}
