import { describe, expect, it } from "vitest";

import {
  calculateDeliveryFee,
  calculatePlatformFee,
  calculateVendorEarnings,
} from "./pricing";

describe("calculatePlatformFee", () => {
  it("returns 0 when subtotal is 0", () => {
    expect(calculatePlatformFee(0, 1000)).toBe(0);
  });

  it("returns 0 when fee bps is 0", () => {
    expect(calculatePlatformFee(12345, 0)).toBe(0);
  });

  it("calculates 10% (1000 bps) of an exact amount", () => {
    expect(calculatePlatformFee(10000, 1000)).toBe(1000);
  });

  it("calculates 5% (500 bps) of an exact amount", () => {
    expect(calculatePlatformFee(20000, 500)).toBe(1000);
  });

  it("rounds to the nearest cent", () => {
    // 1234 * 0.10 = 123.4 → 123
    expect(calculatePlatformFee(1234, 1000)).toBe(123);
    // 1235 * 0.10 = 123.5 → 124 (banker's? Math.round: 124)
    expect(calculatePlatformFee(1235, 1000)).toBe(124);
  });

  it("returns integer cents (no floating point drift)", () => {
    const fee = calculatePlatformFee(99999, 750);
    expect(Number.isInteger(fee)).toBe(true);
  });

  it("throws on negative subtotal", () => {
    expect(() => calculatePlatformFee(-1, 1000)).toThrow();
  });

  it("throws on negative bps", () => {
    expect(() => calculatePlatformFee(100, -5)).toThrow();
  });
});

describe("calculateDeliveryFee", () => {
  it("returns base fee only when weight is 0", () => {
    expect(
      calculateDeliveryFee({ baseFeeAmount: 500, feePerKgAmount: 200, totalWeightGrams: 0 }),
    ).toBe(500);
  });

  it("rounds weight up to the next whole kg", () => {
    // 1g still costs 1kg of perKg fee
    expect(
      calculateDeliveryFee({ baseFeeAmount: 0, feePerKgAmount: 100, totalWeightGrams: 1 }),
    ).toBe(100);
    // 1500g rounds up to 2kg
    expect(
      calculateDeliveryFee({ baseFeeAmount: 0, feePerKgAmount: 100, totalWeightGrams: 1500 }),
    ).toBe(200);
    // exactly 2000g stays 2kg
    expect(
      calculateDeliveryFee({ baseFeeAmount: 0, feePerKgAmount: 100, totalWeightGrams: 2000 }),
    ).toBe(200);
  });

  it("combines base fee and per-kg surcharge", () => {
    expect(
      calculateDeliveryFee({ baseFeeAmount: 500, feePerKgAmount: 200, totalWeightGrams: 2500 }),
    ).toBe(500 + 3 * 200);
  });

  it("throws on negative inputs", () => {
    expect(() =>
      calculateDeliveryFee({ baseFeeAmount: -1, feePerKgAmount: 0, totalWeightGrams: 0 }),
    ).toThrow();
    expect(() =>
      calculateDeliveryFee({ baseFeeAmount: 0, feePerKgAmount: -1, totalWeightGrams: 0 }),
    ).toThrow();
    expect(() =>
      calculateDeliveryFee({ baseFeeAmount: 0, feePerKgAmount: 0, totalWeightGrams: -1 }),
    ).toThrow();
  });
});

describe("calculateVendorEarnings", () => {
  it("equals subtotal minus platform fee", () => {
    expect(calculateVendorEarnings(10000, 1000)).toBe(9000);
  });

  it("ignores delivery fee (caller must pass subtotal only)", () => {
    const subtotal = 10000;
    const platformFee = calculatePlatformFee(subtotal, 1000);
    const earnings = calculateVendorEarnings(subtotal, platformFee);
    // Delivery fee not part of earnings — invariant for the marketplace.
    expect(earnings + platformFee).toBe(subtotal);
  });
});
