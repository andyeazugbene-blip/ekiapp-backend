import { enqueueEmail } from "../../lib/email-queue";
import { logger } from "../../lib/logger";

/**
 * M8/M9/M10 — actionable ops alert, shared by every Community Buy module
 * that needs one (failed payout, reconciliation mismatch, supplier
 * suspension with active fulfilment, capture blocked by supplier
 * restriction). Same OPS_ALERT_EMAIL pattern already established in
 * stripe.service.ts's dispute handler — no separate alerting channel
 * invented, and no default recipient guessed: a no-op when unconfigured.
 */
export async function alertOps(subject: string, html: string): Promise<void> {
  const opsAlertEmail = process.env.OPS_ALERT_EMAIL;
  if (!opsAlertEmail) return;
  try {
    await enqueueEmail({ to: opsAlertEmail, subject, html });
  } catch (error) {
    logger.error("Community Buy ops alert failed to send (non-blocking)", { errorMessage: error instanceof Error ? error.message : String(error) });
  }
}
