import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePaymentIntentFromCartInput,
  PricedOrderItem,
} from "./payments.types";

export function validateCreatePaymentIntentFromCartInput(
  input: unknown,
): CreatePaymentIntentFromCartInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.cartId !== "string" || raw.cartId.trim().length === 0) {
    throw new AppError("Invalid cartId", 400);
  }

  const result: CreatePaymentIntentFromCartInput = {
    cartId: raw.cartId.trim(),
  };

  // Accept either destinationZoneId (legacy) or deliveryCountry (new)
  if (typeof raw.destinationZoneId === "string" && raw.destinationZoneId.trim().length > 0) {
    result.destinationZoneId = raw.destinationZoneId.trim();
  }
  if (typeof raw.deliveryCountry === "string" && raw.deliveryCountry.trim().length > 0) {
    result.deliveryCountry = raw.deliveryCountry.trim();
  }
  if (typeof raw.deliveryAddress === "string" && raw.deliveryAddress.trim().length > 0) {
    result.deliveryAddress = raw.deliveryAddress.trim();
  }

  // Must have at least one way to resolve delivery zone
  if (!result.destinationZoneId && !result.deliveryCountry) {
    throw new AppError("Either destinationZoneId or deliveryCountry is required", 400);
  }

  // walletAmount (optional, non-negative integer)
  if (raw.walletAmount !== undefined && raw.walletAmount !== null) {
    const walletAmount = Number(raw.walletAmount);
    if (!Number.isInteger(walletAmount) || walletAmount < 0) {
      throw new AppError("walletAmount must be a non-negative integer (cents)", 400);
    }
    result.walletAmount = walletAmount;
  }

  return result;
}

export function assertUniformCurrency(items: PricedOrderItem[]): string {
  const currencies = new Set(items.map((item) => item.currency.toLowerCase()));

  if (currencies.size !== 1) {
    throw new AppError("Products must use the same currency", 400);
  }

  return items[0].currency.toLowerCase();
}
