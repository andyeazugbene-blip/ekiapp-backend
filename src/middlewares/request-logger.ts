import type { NextFunction, Request, Response } from "express";

import { logger } from "../lib/logger";

/**
 * Logs every HTTP request with method, path, status, and duration.
 * Skips health checks to reduce noise.
 */
export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  // Skip health check noise
  if (request.path === "/api/health") {
    next();
    return;
  }

  const start = Date.now();

  response.on("finish", () => {
    const duration = Date.now() - start;
    const level = response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info";

    logger[level]("HTTP request", {
      method: request.method,
      path: request.path,
      status: response.statusCode,
      duration,
      requestId: request.requestId,
      userAgent: request.headers["user-agent"]?.slice(0, 100),
      ip: request.ip,
    });
  });

  next();
}
