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
 * MarketConfiguration.countryCode is an ISO alpha-2 code ("GB"), but
 * Vendor.country / DeliveryZone.country store full free-text country names
 * ("United Kingdom") — the two were never translatable into each other,
 * which let a market's regularDeliveriesEnabled/organiserApplicationsEnabled
 * flags silently fail to apply to the vendor rows they were meant to gate.
 * Covers exactly the 10 approved launch markets (see market-configuration
 * .service.ts INITIAL_MARKETS) plus common name variants already used
 * elsewhere in Vendor.country data.
 */
const MARKET_CODE_COUNTRY_NAMES: Record<string, string[]> = {
  gb: ["United Kingdom", "UK", "England", "Scotland", "Wales"],
  us: ["United States", "USA", "United States of America"],
  ca: ["Canada"],
  fr: ["France"],
  es: ["Spain"],
  pt: ["Portugal"],
  ch: ["Switzerland"],
  be: ["Belgium"],
  it: ["Italy"],
  hr: ["Croatia"],
};

/**
 * Resolve a MarketConfiguration.countryCode (e.g. "GB") to every country-name
 * spelling that may appear in Vendor.country/DeliveryZone.country for that
 * market. Returns [code] unchanged for an unrecognized code so callers can
 * still fall back to matching it literally.
 */
export function countryNamesForMarketCode(countryCode: string): string[] {
  const key = countryCode.trim().toLowerCase();
  return MARKET_CODE_COUNTRY_NAMES[key] ?? [countryCode];
}


/**
 * Currencies supported by the project's Stripe account (Italy-based).
 * African currencies (NGN, GHS, KES, ZAR) are NOT supported by Stripe IT.
 * Use this map to fall back to EUR for unsupported currencies.
 */
export const STRIPE_SUPPORTED_CURRENCIES = [
  "usd", "aed", "afn", "all", "amd", "ang", "aoa", "ars", "aud", "awg", "azn", "bam", "bbd",
  "bdt", "bgn", "bif", "bmd", "bnd", "bob", "brl", "bsd", "bwp", "byn", "bzd", "cad", "cdf",
  "chf", "clp", "cny", "cop", "crc", "cve", "czk", "djf", "dkk", "dop", "dzd", "egp", "etb",
  "eur", "fjd", "fkp", "gbp", "gel", "gip", "gmd", "gnf", "gtq", "gyd", "hkd", "hnl", "hrk",
  "htg", "huf", "idr", "ils", "inr", "isk", "jmd", "jpy", "kes", "kgs", "khr", "kmf", "krw",
  "kyd", "kzt", "lak", "lbp", "lkr", "lrd", "lsl", "mad", "mdl", "mga", "mkd", "mmk", "mnt",
  "mop", "mur", "mvr", "mwk", "mxn", "myr", "mzn", "nad", "ngn", "nio", "nok", "npr", "nzd",
  "pab", "pen", "pgk", "php", "pkr", "pln", "pyg", "qar", "ron", "rsd", "rub", "rwf", "sar",
  "sbd", "scr", "sek", "sgd", "shp", "sle", "sos", "srd", "std", "szl", "thb", "tjs", "top",
  "try", "ttd", "twd", "tzs", "uah", "ugx", "uyu", "uzs", "vnd", "vuv", "wst", "xaf", "xcd",
  "xcg", "xof", "xpf", "yer", "zar", "zmw",
];

/**
 * Resolve a local currency to a Stripe-supported currency.
 * Italy-based Stripe accounts support EUR/USD/GBP and many others,
 * but some African currencies may fail. Fallback to EUR.
 */
export function resolveStripeCurrency(currency: string): string {
  const lower = currency.toLowerCase();
  if (STRIPE_SUPPORTED_CURRENCIES.includes(lower)) {
    return lower;
  }
  return "eur";
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
