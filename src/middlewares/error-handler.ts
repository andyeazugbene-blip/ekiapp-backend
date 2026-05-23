import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";

import { logger, serializeError } from "../lib/logger";
import { captureException } from "../lib/sentry";
import { AppError } from "../shared/errors/app-error";

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const requestContext = {
    method: request.method,
    path: request.path,
    requestId: (request.headers["x-request-id"] as string) ?? undefined,
    userId: request.user?.id,
  };

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error("Unhandled application error", {
        ...requestContext,
        statusCode: error.statusCode,
        ...serializeError(error),
      });
      captureException(error, { ...requestContext, statusCode: error.statusCode });
    } else {
      logger.warn("Request rejected", {
        ...requestContext,
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    response.status(error.statusCode).json({
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      details: error.details ?? null,
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    logger.error("Database initialization error", {
      ...requestContext,
      ...serializeError(error),
    });
    captureException(error, requestContext);
    response.status(503).json({
      message: "Database unavailable",
    });
    return;
  }

  logger.error("Unhandled server error", {
    ...requestContext,
    ...serializeError(error),
  });
  captureException(error, requestContext);

  const message = error instanceof Error ? error.message : "Internal server error";
  response.status(500).json({
    message: "Internal server error",
    // Include error details for debugging (remove in hardened production)
    debug: message,
  });
}
