import { describe, it, expect } from "vitest";

import { validateCreateAddressInput } from "../modules/addresses/addresses.validation";
import { validateAddCartItemInput } from "../modules/cart/cart.validation";
import { validateCreateVendorInput } from "../modules/vendors/vendors.validation";

describe("Input Validation", () => {
  describe("Address validation", () => {
    it("accepts valid address", () => {
      const result = validateCreateAddressInput({
        recipientName: "John Doe",
        line1: "123 Main St",
        city: "London",
        postalCode: "SW1A 1AA",
        country: "UK",
      });
      expect(result.recipientName).toBe("John Doe");
      expect(result.isDefault).toBe(false);
    });

    it("rejects missing required fields", () => {
      expect(() => validateCreateAddressInput({ recipientName: "John" })).toThrow();
    });
  });

  describe("Cart item validation", () => {
    it("accepts valid cart item", () => {
      const result = validateAddCartItemInput({ productId: "prod_123", quantity: 2 });
      expect(result.productId).toBe("prod_123");
      expect(result.quantity).toBe(2);
    });

    it("rejects zero quantity", () => {
      expect(() => validateAddCartItemInput({ productId: "prod_123", quantity: 0 })).toThrow();
    });

    it("rejects missing productId", () => {
      expect(() => validateAddCartItemInput({ quantity: 1 })).toThrow();
    });
  });

  describe("Vendor creation validation", () => {
    it("accepts valid vendor input", () => {
      const result = validateCreateVendorInput({ storeName: "My Store" });
      expect(result.storeName).toBe("My Store");
    });

    it("rejects empty storeName", () => {
      expect(() => validateCreateVendorInput({ storeName: "" })).toThrow();
    });

    it("rejects missing body", () => {
      expect(() => validateCreateVendorInput(null)).toThrow();
    });
  });
});
