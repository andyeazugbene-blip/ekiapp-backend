import type { Worker } from "bullmq";

import { logger } from "../lib/logger";
import { isRedisEnabled } from "../lib/redis";
import { startCartCleanupWorker } from "./cart-cleanup.worker";
import { startEmailsWorker } from "./emails.worker";
import { startEscrowAutoReleaseWorker } from "./escrow-auto-release.worker";
import { startEscrowBalanceCheckWorker } from "./escrow-balance-check.worker";
import { startEscrowTimeoutWorker } from "./escrow-timeout.worker";
import { startNotificationsWorker } from "./notifications.worker";

const activeWorkers: Worker[] = [];

/**
 * Start all background workers. Call this from the server entry point
 * after the app is listening. Workers are no-ops if Redis is unavailable.
 */
export function startWorkers(): void {
  if (!isRedisEnabled()) {
    logger.info("Workers skipped (Redis not configured)");
    return;
  }

  logger.info("Starting background workers...");

  const notif = startNotificationsWorker();
  if (notif) activeWorkers.push(notif);

  const email = startEmailsWorker();
  if (email) activeWorkers.push(email);

  // Legacy stock-alerts worker removed (Phase 3 automation fix) — it
  // duplicated the automation engine's own dedup'd, vendor-toggleable
  // LOW_STOCK_ALERT (detectLowStockAlert(), run via the daily cron sweep).
  // This BullMQ worker also never actually ran on Vercel's serverless
  // runtime in the first place (no long-lived worker process there) — it
  // only fired for any deployment target that DOES run startWorkers()
  // continuously, which is exactly where the duplicate alerts came from.

  const cartResult = startCartCleanupWorker();
  if (cartResult) activeWorkers.push(cartResult.worker);

  const escrowTimeout = startEscrowTimeoutWorker();
  if (escrowTimeout) activeWorkers.push(escrowTimeout);

  const escrowRelease = startEscrowAutoReleaseWorker();
  if (escrowRelease) activeWorkers.push(escrowRelease);

  const escrowBalance = startEscrowBalanceCheckWorker();
  if (escrowBalance) activeWorkers.push(escrowBalance);

  logger.info("All workers started", { count: activeWorkers.length });
}

/**
 * Gracefully shut down all workers. Call on SIGTERM/SIGINT.
 */
export async function stopWorkers(): Promise<void> {
  if (activeWorkers.length === 0) return;

  logger.info("Shutting down workers...", { count: activeWorkers.length });

  await Promise.allSettled(
    activeWorkers.map((w) => w.close()),
  );

  logger.info("All workers stopped");
}
