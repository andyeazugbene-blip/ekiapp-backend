import { AppError } from "../../shared/errors/app-error";
import type { CalculateDeliveryInput } from "./delivery.types";

export function validateCalculateDeliveryInput(input: unknown): CalculateDeliveryInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.cartId !== "string" || raw.cartId.trim().length === 0) {
    throw new AppError("Invalid cartId", 400);
  }
  if (typeof raw.destinationZoneId !== "string" || raw.destinationZoneId.trim().length === 0) {
    throw new AppError("Invalid destinationZoneId", 400);
  }

  return {
    cartId: raw.cartId.trim(),
    destinationZoneId: raw.destinationZoneId.trim(),
  };
}
