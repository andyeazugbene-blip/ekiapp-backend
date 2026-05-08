import type { NextFunction, Request, Response } from "express";

export function notFoundHandler(
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  response.status(404).json({
    message: "Route not found",
  });
}
