import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePaymentIntentFromCartInput,
  CreatePaymentIntentInput,
  CreatePaymentIntentItemInput,
  NormalizedPaymentItem,
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

export function validateCreatePaymentIntentInput(input: unknown): CreatePaymentIntentInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }

  const { buyerId, items } = input as Partial<CreatePaymentIntentInput>;

  if (!buyerId || typeof buyerId !== "string") {
    throw new AppError("Invalid buyer", 400);
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("Empty items", 400);
  }

  return {
    buyerId,
    items: items.map(validateCreatePaymentIntentItem),
  };
}

function validateCreatePaymentIntentItem(item: unknown): CreatePaymentIntentItemInput {
  if (!item || typeof item !== "object") {
    throw new AppError("Invalid product", 400);
  }

  const { productId, quantity } = item as Partial<CreatePaymentIntentItemInput>;

  if (!productId || typeof productId !== "string") {
    throw new AppError("Invalid product", 400);
  }

  if (!Number.isInteger(quantity) || Number(quantity) <= 0) {
    throw new AppError("Invalid quantity", 400);
  }

  return {
    productId,
    quantity: Number(quantity),
  };
}

export function normalizePaymentItems(items: CreatePaymentIntentItemInput[]): NormalizedPaymentItem[] {
  const quantitiesByProductId = new Map<string, number>();

  for (const item of items) {
    quantitiesByProductId.set(
      item.productId,
      (quantitiesByProductId.get(item.productId) ?? 0) + item.quantity,
    );
  }

  return [...quantitiesByProductId.entries()].map(([productId, quantity]) => ({
    productId,
    quantity,
  }));
}

export function assertSingleVendor(items: PricedOrderItem[]): string {
  const vendorIds = new Set(items.map((item) => item.vendorId));

  if (vendorIds.size !== 1) {
    throw new AppError("Product from multiple vendors", 400);
  }

  return items[0].vendorId;
}

export function assertUniformCurrency(items: PricedOrderItem[]): string {
  const currencies = new Set(items.map((item) => item.currency.toLowerCase()));

  if (currencies.size !== 1) {
    throw new AppError("Products must use the same currency", 400);
  }

  return items[0].currency.toLowerCase();
}
