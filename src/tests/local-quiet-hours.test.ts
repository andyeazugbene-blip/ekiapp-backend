/**
 * Bug fix 2026-10-11 ("local-time quiet hours"): unit coverage for the pure
 * conversion math itself, independent of the automation service's
 * end-to-end tests (automation.test.ts) which exercise it through real
 * scheduleAutomation() calls at a couple of representative hours.
 */
import { describe, it, expect } from "vitest";
import { localQuietHoursToUtc, utcOffsetHoursForCountry } from "../shared/currency";

describe("utcOffsetHoursForCountry", () => {
  it("resolves a mapped market's offset", () => {
    expect(utcOffsetHoursForCountry("United Kingdom")).toBe(0);
    expect(utcOffsetHoursForCountry("Romania")).toBe(2);
    expect(utcOffsetHoursForCountry("United States")).toBe(-5);
  });

  it("returns null for an unmapped/unknown country rather than guessing", () => {
    expect(utcOffsetHoursForCountry("Atlantis")).toBeNull();
    expect(utcOffsetHoursForCountry(null)).toBeNull();
    expect(utcOffsetHoursForCountry(undefined)).toBeNull();
  });
});

describe("localQuietHoursToUtc", () => {
  it("UTC+0 (UK): local window passes through unchanged", () => {
    expect(localQuietHoursToUtc("United Kingdom", 22, 7)).toEqual({ startUtc: 22, endUtc: 7 });
  });

  it("UTC+2 (Romania): 22:00-07:00 local shifts to 20:00-05:00 UTC", () => {
    expect(localQuietHoursToUtc("Romania", 22, 7)).toEqual({ startUtc: 20, endUtc: 5 });
  });

  it("UTC-5 (US): 22:00-07:00 local shifts to 03:00-12:00 UTC (wraps past midnight correctly)", () => {
    expect(localQuietHoursToUtc("United States", 22, 7)).toEqual({ startUtc: 3, endUtc: 12 });
  });

  it("returns null for an unmapped country so the caller can fall back to its own default", () => {
    expect(localQuietHoursToUtc("Atlantis", 22, 7)).toBeNull();
  });
});
