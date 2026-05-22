import { Queue, Worker } from "bullmq";

import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import { escrowService } from "../modules/paystack/escrow.service";

const QUEUE_NAME = "escrow-auto-release";
const REPEAT_EVERY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Background worker that auto-releases escrow payments for DISPATCHED orders
 * where the 24-hour window has expired without buyer OTP or dispute.
 */
export function startEscrowAutoReleaseWorker(): Worker | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const queue = new Queue(QUEUE_NAME, { connection });
  queue.upsertJobScheduler("escrow-auto-release-check", { every: REPEAT_EVERY_MS }, {
    name: "check-auto-releases",
  }).catch((err) => {
    logger.warn("Failed to schedule escrow auto-release job", { error: String(err) });
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const count = await escrowService.processAutoReleases();
      if (count > 0) {
        logger.info("Escrow auto-release: released payments", { count });
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error("Escrow auto-release job failed", { jobId: job?.id, error: err.message });
  });

  logger.info("Escrow auto-release worker started", { intervalMs: REPEAT_EVERY_MS });
  return worker;
}
