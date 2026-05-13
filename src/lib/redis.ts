import IORedis, { type Redis, type RedisOptions } from "ioredis";

import { logger } from "./logger";

// Redis connection (lazy, singleton).
//
// If REDIS_URL is unset the app keeps running in local dev with no
// queues attached. Anything that depends on Redis must check
// `isRedisEnabled()` (or accept a possibly-null queue) first.

let connection: Redis | null = null;

const url = process.env.REDIS_URL;

if (url) {
  try {
    const options: RedisOptions = {
      // Required by BullMQ workers/queues.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    };
    connection = new IORedis(url, options);
    connection.on("error", (error) => {
      logger.warn("Redis connection error", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
    logger.info("Redis connection initialized");
  } catch (error) {
    connection = null;
    logger.warn("Redis initialization failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export function getRedisConnection(): Redis | null {
  return connection;
}

export function isRedisEnabled(): boolean {
  return connection !== null;
}
