import { AppError } from "./errors/app-error";

/**
 * Backend-authoritative currency normalization for multi-currency
 * checkouts. A buyer may add products from vendors with different native
 * currencies (EUR, USD, GBP, ...) to the same cart; at checkout time every
 * line item, delivery fee, and discount is folded into ONE checkout
 * currency using ONE snapshotted rate per order, so exactly one Stripe
 * PaymentIntent is ever created, in one currency.
 *
 * Rate source: a static, hand-reviewed reference table (base GBP), the
 * same figures already used for display-only conversion on the frontend
 * (utils/currency.ts) — NOT a live market feed. This is a deliberate,
 * documented choice: no live FX provider is integrated anywhere in this
 * codebase, and silently wiring one in for real payment amounts without
 * business/legal review of provider, fees, and accuracy would be a bigger
 * and riskier decision than this fix is asking for. What real money
 * requires — a single authoritative source, snapshotted and stored per
 * order, never silently re-fetched for a refund — is satisfied by this
 * table being static and every conversion being persisted at the moment
 * it's used (see Order.exchangeRate / exchangeRateTimestamp). Revisit if
 * the business decides bank-grade live FX is a real requirement.
 */
export const FX_RATE_SOURCE = "eki_static_reference_v1";

// 1 GBP = N units of the target currency. Only currencies with an actual
// reviewed figure are listed — anything else genuinely has no rate here
// (see getFxRate) rather than a fabricated number.
const GBP_BASE_RATES: Record<string, number> = {
  GBP: 1,
  USD: 1.28,
  EUR: 1.17,
  NGN: 1950,
  GHS: 16.45,
  KES: 166,
};

export interface FxRate {
  /** Multiply an amount in `from` by this to get the equivalent in `to`. */
  rate: number;
  timestamp: Date;
  source: string;
}

/**
 * Looks up the authoritative rate to convert `fromCurrency` into
 * `toCurrency`. Throws AppError (FX_RATE_UNAVAILABLE) rather than guessing
 * when either currency has no reviewed reference rate — a missing rate is
 * a real "can't safely charge this" condition, not something to paper over.
 */
export function getFxRate(fromCurrency: string, toCurrency: string): FxRate {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  const timestamp = new Date();

  if (from === to) {
    return { rate: 1, timestamp, source: FX_RATE_SOURCE };
  }

  const fromRate = GBP_BASE_RATES[from];
  const toRate = GBP_BASE_RATES[to];
  if (!fromRate || !toRate) {
    throw new AppError(
      `No exchange rate available for ${from} to ${to}`,
      400,
      { fromCurrency: from, toCurrency: to },
      "FX_RATE_UNAVAILABLE",
    );
  }

  const rate = toRate / fromRate;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AppError(
      `Invalid exchange rate computed for ${from} to ${to}`,
      400,
      { fromCurrency: from, toCurrency: to, rate },
      "FX_RATE_INVALID",
    );
  }

  return { rate, timestamp, source: FX_RATE_SOURCE };
}

/**
 * Converts a minor-unit amount (cents) from one currency to another using
 * an already-obtained FxRate snapshot. Deterministic, integer-only:
 * standard round-half-up, matching normal money-rounding convention — no
 * floating-point drift is carried forward since the result is always
 * rounded back to a whole minor unit immediately.
 */
export function normalizeMoneyMinor(amountMinor: number, fromCurrency: string, toCurrency: string, fx: FxRate): number {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return amountMinor;
  return Math.round(amountMinor * fx.rate);
}

export function isFxRateSupported(currency: string): boolean {
  return Boolean(GBP_BASE_RATES[currency.toUpperCase()]);
}
