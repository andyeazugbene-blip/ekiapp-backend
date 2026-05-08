import type { NextFunction, Request, Response } from "express";

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

  console.error(error);

  response.status(500).json({
    message: "Internal server error",
  });
}
