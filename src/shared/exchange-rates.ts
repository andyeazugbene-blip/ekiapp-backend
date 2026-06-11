/**
 * Exchange rate service.
 * Fetches live rates from a free API and caches them in-memory for 4 hours.
 * Falls back to approximate rates if the API is unreachable.
 */

const API_URL = "https://api.frankfurter.dev/latest?base=GBP";
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const FALLBACK_RATES: Record<string, number> = {
  GBP: 1, USD: 1.28, EUR: 1.17, NGN: 1950, GHS: 16.45, KES: 166, CAD: 1.74,
};

let cache: { rates: Record<string, number>; fetchedAt: number } | null = null;

async function fetchLiveRates(): Promise<Record<string, number> | null> {
  try {
    const response = await fetch(API_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.rates && typeof data.rates === "object") {
      return { GBP: 1, ...data.rates };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get exchange rates (GBP base). Returns cached rates if available,
 * attempts live fetch otherwise, falls back to hardcoded rates.
 */
export async function getExchangeRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rates;
  }

  const live = await fetchLiveRates();
  if (live) {
    cache = { rates: live, fetchedAt: Date.now() };
    return live;
  }

  // Stale cache is better than nothing
  if (cache) return cache.rates;

  return FALLBACK_RATES;
}

/**
 * Invalidate the cache so the next call fetches fresh rates.
 */
export function invalidateExchangeRateCache(): void {
  cache = null;
}

/**
 * Convert an amount from one currency to another using live rates.
 */
export async function convertCurrency(
  amount: number,
  from: string,
  to: string,
): Promise<number> {
  if (from.toUpperCase() === to.toUpperCase()) return amount;
  const rates = await getExchangeRates();
  const fromRate = rates[from.toUpperCase()] ?? 1;
  const toRate = rates[to.toUpperCase()] ?? 1;
  return (amount / fromRate) * toRate;
}

/**
 * Format a price with a currency symbol.
 */
export function formatPrice(priceInCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(priceInCents / 100);
  } catch {
    return `${(priceInCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * Format a converted price in the display currency.
 */
export async function formatConvertedPrice(
  priceInCents: number,
  sourceCurrency: string,
  displayCurrency: string,
): Promise<string> {
  const converted = await convertCurrency(priceInCents, sourceCurrency, displayCurrency);
  return formatPrice(Math.round(converted * 100), displayCurrency);
}
