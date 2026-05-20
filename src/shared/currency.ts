import { AppError } from "./errors/app-error";

/**
 * ISO 4217 currencies supported by the marketplace.
 * Stripe supports these and they cover Italian/EU market needs.
 * Extend as needed — keep lowercase to match Stripe convention.
 */
export const SUPPORTED_CURRENCIES = new Set([
  "eur", // Euro (primary for Italy/EU)
  "usd", // US Dollar
  "gbp", // British Pound
]);

/**
 * Validate and normalize a currency string.
 * Throws AppError 400 if unsupported.
 */
export function validateCurrency(currency: string | undefined | null, fallback?: string): string {
  const normalized = (currency ?? fallback ?? "").trim().toLowerCase();
  if (!normalized) {
    throw new AppError("Currency is required", 400);
  }
  if (!SUPPORTED_CURRENCIES.has(normalized)) {
    throw new AppError(
      `Unsupported currency "${normalized}". Supported: ${[...SUPPORTED_CURRENCIES].join(", ")}`,
      400,
    );
  }
  return normalized;
}
