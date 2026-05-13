import type { Worker } from "bullmq";

import { logger } from "../lib/logger";
import { isRedisEnabled } from "../lib/redis";
import { startCartCleanupWorker } from "./cart-cleanup.worker";
import { startEmailsWorker } from "./emails.worker";
import { startNotificationsWorker } from "./notifications.worker";
import { startStockAlertsWorker } from "./stock-alerts.worker";

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

  const stockResult = startStockAlertsWorker();
  if (stockResult) activeWorkers.push(stockResult.worker);

  const cartResult = startCartCleanupWorker();
  if (cartResult) activeWorkers.push(cartResult.worker);

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
