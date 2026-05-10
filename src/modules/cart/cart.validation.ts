import { AppError } from "../../shared/errors/app-error";
import type { AddCartItemInput, UpdateCartItemInput } from "./cart.types";

function positiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return num;
}

export function validateAddCartItemInput(input: unknown): AddCartItemInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.productId !== "string" || raw.productId.trim().length === 0) {
    throw new AppError("Invalid productId", 400);
  }

  return {
    productId: raw.productId.trim(),
    quantity: positiveInt(raw.quantity, "quantity"),
  };
}

export function validateUpdateCartItemInput(input: unknown): UpdateCartItemInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  return {
    quantity: positiveInt(raw.quantity, "quantity"),
  };
}
