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

  const result: CalculateDeliveryInput = { cartId: raw.cartId.trim() };

  // Accept either destinationZoneId (legacy) or deliveryCountry (preferred —
  // lets the backend resolve each vendor's own eligibility independently
  // instead of the caller pre-picking one zone for the whole cart).
  if (typeof raw.destinationZoneId === "string" && raw.destinationZoneId.trim().length > 0) {
    result.destinationZoneId = raw.destinationZoneId.trim();
  }
  if (typeof raw.deliveryCountry === "string" && raw.deliveryCountry.trim().length > 0) {
    result.deliveryCountry = raw.deliveryCountry.trim();
  }
  if (!result.destinationZoneId && !result.deliveryCountry) {
    throw new AppError("Either destinationZoneId or deliveryCountry is required", 400);
  }

  result.checkoutCurrency =
    typeof raw.checkoutCurrency === "string" && raw.checkoutCurrency.trim().length > 0
      ? raw.checkoutCurrency.trim()
      : undefined;

  return result;
}
