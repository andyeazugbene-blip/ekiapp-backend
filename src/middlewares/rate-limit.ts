import type { NextFunction, Request, Response } from "express";

/**
 * Simple in-memory rate limiter compatible with CommonJS (no ESM deps).
 * For production with multiple instances, replace with Redis-based logic.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message: { error: string };
}) {
  const store = new Map<string, RateLimitEntry>();

  // Cleanup expired entries every minute
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, 60_000).unref();

  return (request: Request, response: Response, next: NextFunction): void => {
    const key = request.ip ?? "unknown";
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Standard headers
    response.setHeader("RateLimit-Limit", options.max);
    response.setHeader("RateLimit-Remaining", Math.max(0, options.max - entry.count));
    response.setHeader("RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > options.max) {
      response.status(429).json(options.message);
      return;
    }

    next();
  };
}

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many authentication attempts, please try again later." },
});

export const paymentsRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many payment requests, please try again later." },
});

export const generalRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." },
});
