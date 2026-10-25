import { Worker, type Job, Queue } from "bullmq";

import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getRedisConnection } from "../lib/redis";
import { failPendingOrderAndReleaseStock } from "../modules/orders/pending-order-stock.service";

const QUEUE_NAME = "cart-cleanup";
const STALE_ORDER_MINUTES = 30; // Orders pending for >30 min with no payment

interface CartCleanupJobData {
  trigger: "scheduled";
}

async function processCartCleanup(_job: Job<CartCleanupJobData>): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_ORDER_MINUTES * 60 * 1000);

  // Find orders that are PENDING (no payment succeeded) and older than cutoff
  const staleOrders = await prisma.order.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
      payment: {
        status: "PENDING",
      },
    },
    include: {
      items: { select: { productId: true, quantity: true } },
      payment: { select: { id: true, stripePaymentIntentId: true } },
    },
  });

  if (staleOrders.length === 0) {
    logger.info("Cart cleanup: no stale orders found");
    return;
  }

  let restoredCount = 0;

  for (const order of staleOrders) {
    try {
      if (!order.payment) continue;
      const restored = await prisma.$transaction((tx) =>
        failPendingOrderAndReleaseStock(tx, {
          orderId: order.id,
          paymentId: order.payment!.id,
          items: order.items,
        }),
      );
      if (restored) restoredCount++;
    } catch (error) {
      logger.error("Cart cleanup: failed to restore order", {
        orderId: order.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("Cart cleanup completed", {
    staleOrdersFound: staleOrders.length,
    ordersRestored: restoredCount,
  });
}

export function startCartCleanupWorker(): { worker: Worker; queue: Queue } | null {
  const connection = getRedisConnection();
  if (!connection) {
    logger.info("Cart cleanup worker skipped (no Redis)");
    return null;
  }

  const queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  // Run every 15 minutes
  queue.upsertJobScheduler(
    "cart-cleanup-scheduler",
    { every: 15 * 60 * 1000 }, // 15 minutes
    { name: "cart-cleanup-check", data: { trigger: "scheduled" } },
  );

  const worker = new Worker(
    QUEUE_NAME,
    processCartCleanup,
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error("Cart cleanup job failed", {
      jobId: job?.id,
      errorMessage: error.message,
    });
  });

  logger.info("Cart cleanup worker started (runs every 15m)");
  return { worker, queue };
}
