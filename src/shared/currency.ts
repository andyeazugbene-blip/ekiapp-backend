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
 * Covers every approved launch market (see market-configuration.service.ts
 * INITIAL_MARKETS) plus common name variants already used elsewhere in
 * Vendor.country data.
 *
 * Client decision (2026-09-22, "EKI — FINAL PRODUCTION CLOSURE", item 1):
 * Community Buy launch scope expanded from the original 7 European markets
 * to every country classified as Europe, plus GB/US/CA (unchanged). No
 * broader "Europe" registry existed anywhere else in this codebase at the
 * time of this change (checked shipping/delivery-zone config, currency
 * resolution, vendor/organiser market-assignment code — this table was the
 * only country/market registry that existed) — so this list was built as a
 * standard, defensible European-sovereign-state set (UN M49 "Europe"
 * region), restricted to countries with a real ISO 3166-1 alpha-2 code and
 * a currency Stripe actually processes (see STRIPE_SUPPORTED_CURRENCIES
 * below). Russia, Belarus and Ukraine are deliberately excluded: none of
 * RUB/BYN/UAH appears in STRIPE_SUPPORTED_CURRENCIES, so Stripe cannot
 * process payments in any of the three regardless of this list, and Russia
 * and Belarus are additionally under active international sanctions.
 * Kosovo is excluded for lacking a standard, universally-assigned ISO
 * 3166-1 alpha-2 code. Vatican City is excluded as having no realistic
 * resident/commercial population to serve. Every other sovereign European
 * state is included. Africa remains completely absent from this table, as
 * required.
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
  de: ["Germany"],
  nl: ["Netherlands", "The Netherlands", "Holland"],
  at: ["Austria"],
  ie: ["Ireland"],
  lu: ["Luxembourg"],
  gr: ["Greece"],
  cy: ["Cyprus"],
  mt: ["Malta"],
  si: ["Slovenia"],
  sk: ["Slovakia"],
  ee: ["Estonia"],
  lv: ["Latvia"],
  lt: ["Lithuania"],
  fi: ["Finland"],
  pl: ["Poland"],
  cz: ["Czechia", "Czech Republic"],
  hu: ["Hungary"],
  ro: ["Romania"],
  bg: ["Bulgaria"],
  dk: ["Denmark"],
  se: ["Sweden"],
  no: ["Norway"],
  is: ["Iceland"],
  li: ["Liechtenstein"],
  mc: ["Monaco"],
  ad: ["Andorra"],
  sm: ["San Marino"],
  ba: ["Bosnia and Herzegovina", "Bosnia"],
  rs: ["Serbia"],
  me: ["Montenegro"],
  mk: ["North Macedonia", "Macedonia"],
  al: ["Albania"],
  md: ["Moldova"],
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
 * Every approved launch market's canonical ISO code, keyed by every raw
 * spelling that may appear in free-text country fields (OrganiserProfile.
 * country, SupplierProfile.country, CommunityCampaign.country, Vendor.
 * country, ...) — the reverse of countryNamesForMarketCode. Built once from
 * the same MARKET_CODE_COUNTRY_NAMES table so there is exactly one place
 * that defines "which countries are the approved launch markets."
 */
const COUNTRY_NAME_TO_MARKET_CODE: Record<string, string> = Object.entries(MARKET_CODE_COUNTRY_NAMES)
  .reduce<Record<string, string>>((acc, [code, names]) => {
    acc[code] = code.toUpperCase();
    for (const name of names) acc[name.toLowerCase()] = code.toUpperCase();
    return acc;
  }, {});

/**
 * Resolve ANY raw country representation (a full name like "United Kingdom",
 * a common alias like "UK", or an ISO code like "gb") to its
 * MarketConfiguration.countryCode. Returns null for a country that isn't
 * one of the approved launch markets — callers must treat that as "not
 * a recognized market" (fail closed), not silently pass the raw string
 * through to a countryCode-keyed lookup that will just never match.
 */
export function resolveMarketCode(rawCountry: string | null | undefined): string | null {
  if (!rawCountry) return null;
  return COUNTRY_NAME_TO_MARKET_CODE[rawCountry.trim().toLowerCase()] ?? null;
}

/** The exact set of approved launch markets' canonical display names, for UI pickers. One name per code — the first entry in MARKET_CODE_COUNTRY_NAMES. */
export const LAUNCH_MARKET_COUNTRIES: { code: string; name: string }[] = Object.entries(MARKET_CODE_COUNTRY_NAMES).map(
  ([code, names]) => ({ code: code.toUpperCase(), name: names[0] }),
);

const MARKET_CODE_TO_COUNTRY_NAME: Record<string, string> = Object.fromEntries(
  LAUNCH_MARKET_COUNTRIES.map((market) => [market.code, market.name]),
);

/**
 * Canonical display name for one of the approved launch markets' ISO
 * codes (e.g. "GB" -> "United Kingdom"). Returns null for anything outside
 * the launch set — callers must not fall back to displaying the raw code,
 * since that's exactly the "US"/"CA"/"GB" leak this exists to prevent.
 */
export function marketCodeToCountryName(marketCode: string): string | null {
  return MARKET_CODE_TO_COUNTRY_NAME[marketCode.trim().toUpperCase()] ?? null;
}

/** True only for one of the approved launch markets' ISO codes — never Africa or any other market. */
export function isApprovedLaunchMarketCode(marketCode: string | null | undefined): boolean {
  if (!marketCode) return false;
  return marketCode.trim().toUpperCase() in MARKET_CODE_TO_COUNTRY_NAME;
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

/**
 * Approximate standard-time UTC offset (hours, no DST) per approved launch
 * market code. Deliberately a coarse, documented approximation rather than
 * a real timezone database (none is a dependency of this project) — good
 * enough to turn a vendor's "do not message me at 2am" expectation into a
 * real per-country shift instead of one global UTC window for every
 * market, which was the actual bug (handbook/automation-timing fix
 * 2026-10-11: "local-time quiet hours"). DST is NOT modeled: a UK/EU
 * vendor's quiet hours may be off by up to an hour for part of the year.
 * One representative offset per country, same keys as
 * MARKET_CODE_COUNTRY_NAMES above.
 */
const MARKET_UTC_OFFSET_HOURS: Record<string, number> = {
  gb: 0, ie: 0, pt: 0, is: 0,
  fr: 1, es: 1, ch: 1, be: 1, it: 1, hr: 1, de: 1, nl: 1, at: 1, lu: 1, pl: 1, cz: 1, hu: 1, dk: 1, se: 1, no: 1,
  li: 1, mc: 1, ad: 1, sm: 1, ba: 1, rs: 1, me: 1, mk: 1, al: 1,
  gr: 2, cy: 2, mt: 2, si: 2, sk: 2, ee: 2, lv: 2, lt: 2, fi: 2, ro: 2, bg: 2, md: 2,
  us: -5, // one representative US offset (Eastern) — a genuinely per-timezone US model is out of scope here.
  ca: -5, // same caveat (Eastern).
};

/** Resolve any raw country representation to its approximate standard-time UTC offset in hours, or null if unmapped (callers must fall back to a global UTC window, never guess). */
export function utcOffsetHoursForCountry(rawCountry: string | null | undefined): number | null {
  const code = resolveMarketCode(rawCountry);
  if (!code) return null;
  const offset = MARKET_UTC_OFFSET_HOURS[code.toLowerCase()];
  return typeof offset === "number" ? offset : null;
}

/**
 * Converts a desired LOCAL quiet-hour window (e.g. 21:00-08:00 in the
 * recipient's own approximate local time) into the equivalent UTC hour
 * window, given that recipient's country. Returns null when the country
 * doesn't resolve to a known market — caller should fall back to its
 * existing global UTC default rather than silently using no quiet hours
 * at all.
 */
export function localQuietHoursToUtc(
  rawCountry: string | null | undefined,
  localStartHour: number,
  localEndHour: number,
): { startUtc: number; endUtc: number } | null {
  const offset = utcOffsetHoursForCountry(rawCountry);
  if (offset === null) return null;
  const wrap = (h: number) => ((h - offset) % 24 + 24) % 24;
  return { startUtc: wrap(localStartHour), endUtc: wrap(localEndHour) };
}
