import { AppError } from "../../shared/errors/app-error";
import type { CreatePaymentIntentFromCartInput } from "./payments.types";

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

  // promoCode (optional)
  if (typeof raw.promoCode === "string" && raw.promoCode.trim().length > 0) {
    result.promoCode = raw.promoCode.trim().toUpperCase();
  }
  if (typeof raw.promoVendorId === "string" && raw.promoVendorId.trim().length > 0) {
    result.promoVendorId = raw.promoVendorId.trim();
  }

  return result;
}
