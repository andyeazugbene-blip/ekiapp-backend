import { Queue, Worker } from "bullmq";

import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import { escrowHealthService } from "../modules/paystack/escrow-health.service";

const QUEUE_NAME = "escrow-balance-check";
const REPEAT_EVERY_MS = 6 * 60 * 60 * 1000; // Every 6 hours

/**
 * Background worker that checks escrow outstanding amounts and alerts ops
 * if the balance threshold is exceeded.
 */
export function startEscrowBalanceCheckWorker(): Worker | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const queue = new Queue(QUEUE_NAME, { connection });
  queue.upsertJobScheduler("escrow-balance-check", { every: REPEAT_EVERY_MS }, {
    name: "check-balance",
  }).catch((err) => {
    logger.warn("Failed to schedule escrow balance check", { error: String(err) });
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await escrowHealthService.checkAndAlert();
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error("Escrow balance check failed", { jobId: job?.id, error: err.message });
  });

  logger.info("Escrow balance check worker started", { intervalMs: REPEAT_EVERY_MS });
  return worker;
}
