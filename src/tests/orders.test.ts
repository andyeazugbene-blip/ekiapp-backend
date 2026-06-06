import { describe, it, expect } from "vitest";

import { validateListBuyerOrdersQuery, validateUpdateOrderStatusInput } from "../modules/orders/orders.validation";
import { VENDOR_STATUS_TRANSITIONS } from "../modules/orders/orders.types";

describe("Orders Validation", () => {
  describe("validateListBuyerOrdersQuery", () => {
    it("returns defaults for empty query", () => {
      const result = validateListBuyerOrdersQuery({});
      expect(result.limit).toBe(20);
      expect(result.status).toBeUndefined();
      expect(result.cursor).toBeUndefined();
    });

    it("accepts valid status filter", () => {
      const result = validateListBuyerOrdersQuery({ status: "PAID", limit: "10" });
      expect(result.status).toBe("PAID");
      expect(result.limit).toBe(10);
    });

    it("rejects invalid status", () => {
      expect(() => validateListBuyerOrdersQuery({ status: "INVALID" })).toThrow();
    });

    it("rejects invalid limit", () => {
      expect(() => validateListBuyerOrdersQuery({ limit: "0" })).toThrow();
      expect(() => validateListBuyerOrdersQuery({ limit: "999" })).toThrow();
    });
  });

  describe("validateUpdateOrderStatusInput", () => {
    it("accepts valid status", () => {
      const result = validateUpdateOrderStatusInput({ status: "CONFIRMED" });
      expect(result.status).toBe("CONFIRMED");
    });

    it("rejects invalid status", () => {
      expect(() => validateUpdateOrderStatusInput({ status: "BOGUS" })).toThrow();
    });
  });

  describe("VENDOR_STATUS_TRANSITIONS", () => {
    it("allows PAID → CONFIRMED", () => {
      expect(VENDOR_STATUS_TRANSITIONS.PAID).toContain("CONFIRMED");
    });

    it("allows CONFIRMED → PROCESSING", () => {
      expect(VENDOR_STATUS_TRANSITIONS.CONFIRMED).toContain("PROCESSING");
    });

    it("allows PENDING → CONFIRMED", () => {
      expect(VENDOR_STATUS_TRANSITIONS.PENDING).toContain("CONFIRMED");
    });

    it("does not allow COMPLETED → anything", () => {
      expect(VENDOR_STATUS_TRANSITIONS.COMPLETED).toHaveLength(0);
    });
  });
});
