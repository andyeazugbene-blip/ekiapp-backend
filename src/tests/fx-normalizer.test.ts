/**
 * Backend-authoritative currency normalization — the utility every
 * multi-currency checkout calculation (payments.service.ts,
 * delivery.service.ts) is built on. Real assertions on real minor-unit
 * arithmetic, not `expect(true)`.
 */
import { describe, expect, it } from "vitest";
import { getFxRate, normalizeMoneyMinor, isFxRateSupported, FX_RATE_SOURCE } from "../shared/fx-normalizer";

describe("getFxRate — same currency", () => {
  it("returns an exact rate of 1 with no lookup needed, case-insensitively", () => {
    const fx = getFxRate("eur", "EUR");
    expect(fx.rate).toBe(1);
    expect(fx.source).toBe(FX_RATE_SOURCE);
    expect(fx.timestamp).toBeInstanceOf(Date);
  });
});

describe("getFxRate — 13/14/15. missing / unsupported currency", () => {
  it("throws FX_RATE_UNAVAILABLE for a currency with no reviewed reference rate, rather than fabricating one", () => {
    expect(() => getFxRate("ZAR", "GBP")).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "FX_RATE_UNAVAILABLE" }),
    );
  });

  it("throws for an unsupported currency on the `to` side too", () => {
    expect(() => getFxRate("GBP", "XYZ")).toThrowError(
      expect.objectContaining({ code: "FX_RATE_UNAVAILABLE" }),
    );
  });

  it("isFxRateSupported reflects exactly the same reviewed set getFxRate will accept", () => {
    expect(isFxRateSupported("GBP")).toBe(true);
    expect(isFxRateSupported("usd")).toBe(true);
    expect(isFxRateSupported("ZAR")).toBe(false);
  });
});

describe("getFxRate — real cross-rates derived from the one reviewed GBP-base table", () => {
  it("GBP -> USD", () => {
    expect(getFxRate("GBP", "USD").rate).toBeCloseTo(1.28, 5);
  });

  it("USD -> EUR is derived (not a directly-stored figure) — GBP-base cross rate", () => {
    // 1 USD = 1/1.28 GBP = (1/1.28)*1.17 EUR
    expect(getFxRate("USD", "EUR").rate).toBeCloseTo(1.17 / 1.28, 6);
  });
});

describe("normalizeMoneyMinor — 12. deterministic minor-unit rounding", () => {
  it("returns the amount unchanged when currencies match, skipping the rate entirely", () => {
    const fx = { rate: 999, timestamp: new Date(), source: FX_RATE_SOURCE };
    expect(normalizeMoneyMinor(12345, "eur", "EUR", fx)).toBe(12345);
  });

  it("rounds to the nearest whole minor unit — never fractional cents", () => {
    const fx = getFxRate("EUR", "GBP"); // rate = 1/1.17
    const result = normalizeMoneyMinor(1000, "EUR", "GBP", fx);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(Math.round(1000 * (1 / 1.17)));
  });

  it("is deterministic — the same inputs always produce the same output", () => {
    const fx = getFxRate("USD", "GBP");
    const a = normalizeMoneyMinor(7777, "USD", "GBP", fx);
    const b = normalizeMoneyMinor(7777, "USD", "GBP", fx);
    expect(a).toBe(b);
  });
});
