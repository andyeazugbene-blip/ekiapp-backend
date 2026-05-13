import { describe, it, expect } from "vitest";

import { validateCreatePromoCodeInput, validateValidatePromoInput } from "../modules/promos/promos.validation";

describe("Promo Validation", () => {
  describe("validateCreatePromoCodeInput", () => {
    it("accepts valid percentage promo", () => {
      const result = validateCreatePromoCodeInput({
        code: "SAVE10",
        type: "PERCENTAGE",
        value: 10,
      });
      expect(result.code).toBe("SAVE10");
      expect(result.type).toBe("PERCENTAGE");
      expect(result.value).toBe(10);
    });

    it("accepts valid fixed amount promo", () => {
      const result = validateCreatePromoCodeInput({
        code: "flat500",
        type: "FIXED_AMOUNT",
        value: 500,
        minOrderAmount: 2000,
      });
      expect(result.code).toBe("FLAT500");
      expect(result.value).toBe(500);
      expect(result.minOrderAmount).toBe(2000);
    });

    it("rejects percentage > 100", () => {
      expect(() => validateCreatePromoCodeInput({
        code: "BAD",
        type: "PERCENTAGE",
        value: 150,
      })).toThrow("Percentage value cannot exceed 100");
    });

    it("rejects invalid type", () => {
      expect(() => validateCreatePromoCodeInput({
        code: "X",
        type: "BOGUS",
        value: 10,
      })).toThrow();
    });
  });

  describe("validateValidatePromoInput", () => {
    it("accepts valid input", () => {
      const result = validateValidatePromoInput({ code: "AFRO10", orderAmount: 5000 });
      expect(result.code).toBe("AFRO10");
      expect(result.orderAmount).toBe(5000);
    });

    it("rejects missing code", () => {
      expect(() => validateValidatePromoInput({ orderAmount: 5000 })).toThrow();
    });

    it("rejects non-positive amount", () => {
      expect(() => validateValidatePromoInput({ code: "X", orderAmount: 0 })).toThrow();
    });
  });
});
