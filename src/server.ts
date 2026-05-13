import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { bootstrapAdmin } from "./modules/admin/admin-bootstrap";
import { startWorkers, stopWorkers } from "./workers";

const server = app.listen(env.port, async () => {
  logger.info(`Server listening on port ${env.port}`, { env: env.nodeEnv });
  await bootstrapAdmin();
  startWorkers();
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed");
  });

  // Stop workers
  await stopWorkers();

  // Give in-flight requests 10s to complete
  setTimeout(() => {
    logger.warn("Forcing shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
