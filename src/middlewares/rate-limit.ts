import rateLimit, { type Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";

import { getRedisConnection } from "../lib/redis";

// Use Redis store in production for distributed rate limiting.
// Falls back to in-memory store in dev (no Redis).
function getStore(): Options["store"] | undefined {
  const redis = getRedisConnection();
  if (!redis) return undefined; // MemoryStore (default)

  return new RedisStore({
    // @ts-expect-error - ioredis sendCommand is compatible
    sendCommand: (...args: string[]) => redis.call(...args),
  });
}

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getStore(),
  message: { error: "Too many authentication attempts, please try again later." },
});

export const paymentsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: getStore(),
  message: { error: "Too many payment requests, please try again later." },
});

export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: getStore(),
  message: { error: "Too many requests, please try again later." },
});
