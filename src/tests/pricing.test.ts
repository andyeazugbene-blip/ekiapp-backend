import { describe, it, expect } from "vitest";

import { calculatePlatformFee, calculateDeliveryFee, calculateVendorEarnings } from "../shared/pricing";

describe("Pricing", () => {
  describe("calculatePlatformFee", () => {
    it("calculates 10% fee correctly", () => {
      expect(calculatePlatformFee(10000, 1000)).toBe(1000);
    });

    it("calculates 5% fee correctly", () => {
      expect(calculatePlatformFee(10000, 500)).toBe(500);
    });

    it("rounds to nearest cent", () => {
      expect(calculatePlatformFee(9999, 1000)).toBe(1000); // 999.9 → 1000
    });

    it("returns 0 for 0 amount", () => {
      expect(calculatePlatformFee(0, 1000)).toBe(0);
    });

    it("throws on negative amount", () => {
      expect(() => calculatePlatformFee(-100, 1000)).toThrow();
    });
  });

  describe("calculateDeliveryFee", () => {
    it("calculates base + weight fee", () => {
      expect(calculateDeliveryFee({
        baseFeeAmount: 500,
        feePerKgAmount: 200,
        totalWeightGrams: 2500,
      })).toBe(1100); // 500 + 3kg * 200
    });

    it("rounds weight up to nearest kg", () => {
      expect(calculateDeliveryFee({
        baseFeeAmount: 500,
        feePerKgAmount: 200,
        totalWeightGrams: 100,
      })).toBe(700); // 500 + 1kg * 200
    });

    it("handles zero weight", () => {
      expect(calculateDeliveryFee({
        baseFeeAmount: 500,
        feePerKgAmount: 200,
        totalWeightGrams: 0,
      })).toBe(500);
    });
  });

  describe("calculateVendorEarnings", () => {
    it("subtracts platform fee from subtotal", () => {
      expect(calculateVendorEarnings(10000, 1000)).toBe(9000);
    });
  });
});
