import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";

import { AppError } from "../shared/errors/app-error";

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      message: error.message,
      details: error.details ?? null,
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    console.error("Database initialization error", error);

    response.status(503).json({
      message: "Database unavailable",
    });
    return;
  }

  console.error(error);

  response.status(500).json({
    message: "Internal server error",
  });
}
