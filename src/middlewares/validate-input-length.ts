import type { NextFunction, Request, Response } from "express";

import { AppError } from "../shared/errors/app-error";

const MAX_STRING_LENGTH = 5000;
const MAX_ARRAY_LENGTH = 100;
const MAX_DEPTH = 10;

/**
 * Middleware that validates request body doesn't contain excessively long
 * strings or deeply nested objects. Prevents abuse via oversized payloads
 * that pass JSON parsing but could cause DB/memory issues.
 */
export function validateInputLength(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  // Skip raw Buffer bodies (e.g. Stripe webhook raw payload)
  if (!request.body || typeof request.body !== "object" || Buffer.isBuffer(request.body)) {
    next();
    return;
  }

  try {
    validateObject(request.body, 0);
    next();
  } catch (error) {
    next(error);
  }
}

function validateObject(obj: unknown, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new AppError("Request body is too deeply nested", 400);
  }

  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_LENGTH) {
      throw new AppError(`Array exceeds maximum length of ${MAX_ARRAY_LENGTH}`, 400);
    }
    for (const item of obj) {
      if (typeof item === "object" && item !== null) {
        validateObject(item, depth + 1);
      } else if (typeof item === "string" && item.length > MAX_STRING_LENGTH) {
        throw new AppError(`String value exceeds maximum length of ${MAX_STRING_LENGTH}`, 400);
      }
    }
    return;
  }

  if (typeof obj === "object" && obj !== null) {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length > 200) {
      throw new AppError("Request body has too many fields", 400);
    }
    for (const [, value] of entries) {
      if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
        throw new AppError(`String value exceeds maximum length of ${MAX_STRING_LENGTH}`, 400);
      }
      if (typeof value === "object" && value !== null) {
        validateObject(value, depth + 1);
      }
    }
  }
}
