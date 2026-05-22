import { Queue, Worker } from "bullmq";

import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import { escrowService } from "../modules/paystack/escrow.service";

const QUEUE_NAME = "escrow-vendor-timeout";
const REPEAT_EVERY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Background worker that checks for escrow orders where the vendor
 * did not confirm within the timeout window (48 hours by default).
 * Auto-cancels and refunds the buyer via Paystack.
 */
export function startEscrowTimeoutWorker(): Worker | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  // Create repeatable job
  const queue = new Queue(QUEUE_NAME, { connection });
  queue.upsertJobScheduler("escrow-timeout-check", { every: REPEAT_EVERY_MS }, {
    name: "check-vendor-timeouts",
  }).catch((err) => {
    logger.warn("Failed to schedule escrow timeout job", { error: String(err) });
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const count = await escrowService.processVendorTimeouts();
      if (count > 0) {
        logger.info("Escrow vendor timeout: cancelled expired orders", { count });
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error("Escrow timeout job failed", { jobId: job?.id, error: err.message });
  });

  logger.info("Escrow vendor timeout worker started", { intervalMs: REPEAT_EVERY_MS });
  return worker;
}
