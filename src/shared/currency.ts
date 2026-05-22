/**
 * Supported currencies and country-to-currency mapping.
 * Vendor.currency is derived from Vendor.country at creation time.
 * Product.currency inherits from Vendor.currency.
 */

export const SUPPORTED_CURRENCIES = ["GBP", "EUR", "USD", "NGN", "GHS", "KES", "ZAR"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Map country name/code to currency. Case-insensitive matching.
 */
const COUNTRY_CURRENCY_MAP: Record<string, SupportedCurrency> = {
  // UK
  uk: "GBP",
  "united kingdom": "GBP",
  gb: "GBP",
  england: "GBP",
  scotland: "GBP",
  wales: "GBP",
  // EU / Italy
  italy: "EUR",
  it: "EUR",
  france: "EUR",
  germany: "EUR",
  spain: "EUR",
  netherlands: "EUR",
  belgium: "EUR",
  portugal: "EUR",
  ireland: "EUR",
  austria: "EUR",
  greece: "EUR",
  // US
  us: "USD",
  usa: "USD",
  "united states": "USD",
  // Nigeria
  nigeria: "NGN",
  ng: "NGN",
  // Ghana
  ghana: "GHS",
  gh: "GHS",
  // Kenya
  kenya: "KES",
  ke: "KES",
  // South Africa
  "south africa": "ZAR",
  za: "ZAR",
};

/**
 * Derive currency from country. Returns EUR as default for unknown countries.
 */
export function currencyFromCountry(country: string | null | undefined): SupportedCurrency {
  if (!country) return "EUR";
  const key = country.trim().toLowerCase();
  return COUNTRY_CURRENCY_MAP[key] ?? "EUR";
}

/**
 * Validate that a currency string is in the supported whitelist.
 */
export function isSupportedCurrency(currency: string): currency is SupportedCurrency {
  return SUPPORTED_CURRENCIES.includes(currency.toUpperCase() as SupportedCurrency);
}


/**
 * Validate currency and throw if not supported.
 * Used in admin delivery zone creation and product creation.
 */
export function validateCurrency(currency: string | undefined | null, fallback?: string): SupportedCurrency {
  const value = currency ?? fallback ?? "EUR";
  const upper = value.toUpperCase();
  if (!isSupportedCurrency(upper)) {
    throw new Error(`Unsupported currency: ${value}. Supported: ${SUPPORTED_CURRENCIES.join(", ")}`);
  }
  return upper as SupportedCurrency;
}
