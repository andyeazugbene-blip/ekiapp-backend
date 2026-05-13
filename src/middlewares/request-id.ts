import type { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Assigns a unique request ID to each request.
 * Uses X-Request-ID header if provided (from load balancer), otherwise generates one.
 */
export function requestIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const id = (request.headers["x-request-id"] as string) || uuidv4();
  request.requestId = id;
  response.setHeader("X-Request-ID", id);
  next();
}
