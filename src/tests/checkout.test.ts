import { describe, it, expect } from "vitest";

import { validateCreatePaymentIntentFromCartInput } from "../modules/payments/payments.validation";

describe("Checkout Validation", () => {
  it("accepts cartId + destinationZoneId (legacy)", () => {
    const result = validateCreatePaymentIntentFromCartInput({
      cartId: "cart-1",
      destinationZoneId: "zone-1",
    });
    expect(result.cartId).toBe("cart-1");
    expect(result.destinationZoneId).toBe("zone-1");
  });

  it("accepts cartId + deliveryCountry (new)", () => {
    const result = validateCreatePaymentIntentFromCartInput({
      cartId: "cart-1",
      deliveryCountry: "Italy",
    });
    expect(result.cartId).toBe("cart-1");
    expect(result.deliveryCountry).toBe("Italy");
    expect(result.destinationZoneId).toBeUndefined();
  });

  it("accepts deliveryAddress alongside deliveryCountry", () => {
    const result = validateCreatePaymentIntentFromCartInput({
      cartId: "cart-1",
      deliveryCountry: "France",
      deliveryAddress: "123 Rue de Paris",
    });
    expect(result.deliveryAddress).toBe("123 Rue de Paris");
  });

  it("accepts walletAmount as non-negative integer", () => {
    const result = validateCreatePaymentIntentFromCartInput({
      cartId: "cart-1",
      destinationZoneId: "zone-1",
      walletAmount: 500,
    });
    expect(result.walletAmount).toBe(500);
  });

  it("rejects negative walletAmount", () => {
    expect(() =>
      validateCreatePaymentIntentFromCartInput({
        cartId: "cart-1",
        destinationZoneId: "zone-1",
        walletAmount: -100,
      }),
    ).toThrow("walletAmount must be a non-negative integer");
  });

  it("rejects missing cartId", () => {
    expect(() =>
      validateCreatePaymentIntentFromCartInput({
        destinationZoneId: "zone-1",
      }),
    ).toThrow("Invalid cartId");
  });

  it("rejects missing both destinationZoneId and deliveryCountry", () => {
    expect(() =>
      validateCreatePaymentIntentFromCartInput({
        cartId: "cart-1",
      }),
    ).toThrow("Either destinationZoneId or deliveryCountry is required");
  });

  it("rejects non-integer walletAmount", () => {
    expect(() =>
      validateCreatePaymentIntentFromCartInput({
        cartId: "cart-1",
        destinationZoneId: "zone-1",
        walletAmount: 10.5,
      }),
    ).toThrow("walletAmount must be a non-negative integer");
  });

  it("walletAmount of 0 is accepted (no wallet usage)", () => {
    const result = validateCreatePaymentIntentFromCartInput({
      cartId: "cart-1",
      destinationZoneId: "zone-1",
      walletAmount: 0,
    });
    expect(result.walletAmount).toBe(0);
  });
});
