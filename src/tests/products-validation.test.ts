/**
 * Phase 4.2 (test coverage for already-implemented features) — inventory
 * validation rules (products.validation.ts) are real business rules with
 * no dedicated test coverage: stock must be a non-negative integer,
 * isActive is explicitly blocked from vendor PATCH (an admin-moderation
 * bypass otherwise), currency is not vendor-editable, and price must be
 * strictly positive.
 */
import { describe, it, expect } from "vitest";

import { validateCreateProductInput, validateUpdateProductInput, validateListProductsQuery } from "../modules/products/products.validation";

describe("validateCreateProductInput — stock and price rules", () => {
  it("accepts a valid non-negative integer stock", () => {
    const result = validateCreateProductInput({ title: "Rice", priceAmount: 1000, stock: 25 });
    expect(result.stock).toBe(25);
  });

  it("accepts zero stock (out of stock at creation is valid)", () => {
    const result = validateCreateProductInput({ title: "Rice", priceAmount: 1000, stock: 0 });
    expect(result.stock).toBe(0);
  });

  it("rejects negative stock", () => {
    expect(() => validateCreateProductInput({ title: "Rice", priceAmount: 1000, stock: -1 })).toThrow(/invalid stock/i);
  });

  it("rejects a fractional stock value", () => {
    expect(() => validateCreateProductInput({ title: "Rice", priceAmount: 1000, stock: 2.5 })).toThrow(/invalid stock/i);
  });

  it("rejects a zero or negative price", () => {
    expect(() => validateCreateProductInput({ title: "Rice", priceAmount: 0 })).toThrow(/invalid priceAmount/i);
    expect(() => validateCreateProductInput({ title: "Rice", priceAmount: -500 })).toThrow(/invalid priceAmount/i);
  });

  it("rejects a missing/empty title", () => {
    expect(() => validateCreateProductInput({ priceAmount: 1000 })).toThrow(/invalid title/i);
    expect(() => validateCreateProductInput({ title: "   ", priceAmount: 1000 })).toThrow(/invalid title/i);
  });

  it("rejects a non-object body entirely", () => {
    expect(() => validateCreateProductInput(null)).toThrow(/invalid request body/i);
    expect(() => validateCreateProductInput("not an object")).toThrow(/invalid request body/i);
  });
});

describe("validateUpdateProductInput — stock stays optional but validated when present", () => {
  it("allows updating just the stock field", () => {
    const result = validateUpdateProductInput({ stock: 10 });
    expect(result).toEqual({ stock: 10 });
  });

  it("rejects negative stock on update", () => {
    expect(() => validateUpdateProductInput({ stock: -5 })).toThrow(/invalid stock/i);
  });

  it("rejects a zero or negative price on update", () => {
    expect(() => validateUpdateProductInput({ priceAmount: 0 })).toThrow(/invalid priceAmount/i);
  });
});

describe("validateUpdateProductInput — isActive is never vendor-editable", () => {
  it("rejects any attempt to PATCH isActive, regardless of value — real admin-moderation-bypass protection", () => {
    expect(() => validateUpdateProductInput({ isActive: true })).toThrow(/isActive cannot be modified/i);
    expect(() => validateUpdateProductInput({ isActive: false })).toThrow(/isActive cannot be modified/i);
  });

  it("the isActive rejection is a 403, not a 400 — this is an authorization boundary, not a format error", () => {
    try {
      validateUpdateProductInput({ isActive: true });
      throw new Error("should have thrown");
    } catch (err: any) {
      expect(err.statusCode).toBe(403);
    }
  });
});

describe("validateUpdateProductInput — currency normalization and empty-update guard", () => {
  it("uppercases costCurrency", () => {
    const result = validateUpdateProductInput({ costCurrency: "gbp" });
    expect(result.costCurrency).toBe("GBP");
  });

  it("rejects an entirely empty update body — nothing to actually change", () => {
    expect(() => validateUpdateProductInput({})).toThrow(/no fields to update/i);
  });

  it("rejects a null/undefined images entry inside the array", () => {
    expect(() => validateUpdateProductInput({ images: ["https://a.com/1.jpg", ""] })).toThrow(/invalid image/i);
  });

  it("allows clearing costAmount back to null explicitly", () => {
    const result = validateUpdateProductInput({ costAmount: null });
    expect(result.costAmount).toBeNull();
  });
});

describe("validateListProductsQuery — limit bounds", () => {
  it("defaults to 20 when no limit given", () => {
    expect(validateListProductsQuery({}).limit).toBe(20);
  });

  it("rejects a limit above 100", () => {
    expect(() => validateListProductsQuery({ limit: "500" })).toThrow(/invalid limit/i);
  });
});
