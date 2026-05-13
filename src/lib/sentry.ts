import * as Sentry from "@sentry/node";

import { logger } from "./logger";

// Sentry is fully optional. If SENTRY_DSN is not set we keep the SDK
// uninitialized and `captureException` becomes a no-op so local dev
// (and any deploy without monitoring configured) is unaffected.

let initialized = false;

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? "development",
      tracesSampleRate: 0,
    });
    initialized = true;
    logger.info("Sentry initialized");
  } catch (error) {
    logger.warn("Sentry initialization failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } catch {
    // Never let Sentry break the request path.
  }
}
