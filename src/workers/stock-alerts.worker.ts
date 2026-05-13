import { Worker, type Job, Queue } from "bullmq";

import { sendEmail } from "../lib/email";
import { emailTemplates } from "../lib/email-templates";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getRedisConnection } from "../lib/redis";

const QUEUE_NAME = "stock-alerts";
const LOW_STOCK_THRESHOLD = 5;

interface StockAlertJobData {
  trigger: "scheduled";
}

async function processStockAlerts(_job: Job<StockAlertJobData>): Promise<void> {
  // Find all vendors with low-stock products
  const lowStockProducts = await prisma.product.findMany({
    where: {
      isActive: true,
      stock: { lte: LOW_STOCK_THRESHOLD },
    },
    select: {
      title: true,
      stock: true,
      vendorId: true,
      vendor: {
        select: {
          storeName: true,
          contactEmail: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  if (lowStockProducts.length === 0) {
    logger.info("Stock alert check: no low-stock products found");
    return;
  }

  // Group by vendor
  const vendorMap = new Map<string, {
    storeName: string;
    email: string;
    products: { title: string; stock: number }[];
  }>();

  for (const product of lowStockProducts) {
    const existing = vendorMap.get(product.vendorId);
    const email = product.vendor.contactEmail ?? product.vendor.user.email;

    if (existing) {
      existing.products.push({ title: product.title, stock: product.stock });
    } else {
      vendorMap.set(product.vendorId, {
        storeName: product.vendor.storeName,
        email,
        products: [{ title: product.title, stock: product.stock }],
      });
    }
  }

  // Send alerts
  let sentCount = 0;
  for (const [vendorId, data] of vendorMap) {
    const template = emailTemplates.lowStockAlert({
      storeName: data.storeName,
      products: data.products,
    });

    const sent = await sendEmail({
      to: data.email,
      subject: template.subject,
      html: template.html,
    });

    if (sent) sentCount++;
  }

  logger.info("Stock alert check completed", {
    vendorsNotified: sentCount,
    totalLowStockProducts: lowStockProducts.length,
  });
}

export function startStockAlertsWorker(): { worker: Worker; queue: Queue } | null {
  const connection = getRedisConnection();
  if (!connection) {
    logger.info("Stock alerts worker skipped (no Redis)");
    return null;
  }

  const queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 60_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  // Add a repeatable job that runs every 6 hours
  queue.upsertJobScheduler(
    "stock-alert-scheduler",
    { every: 6 * 60 * 60 * 1000 }, // 6 hours
    { name: "stock-alert-check", data: { trigger: "scheduled" } },
  );

  const worker = new Worker(
    QUEUE_NAME,
    processStockAlerts,
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error("Stock alert job failed", {
      jobId: job?.id,
      errorMessage: error.message,
    });
  });

  logger.info("Stock alerts worker started (runs every 6h)");
  return { worker, queue };
}
