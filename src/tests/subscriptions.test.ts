import { describe, it, expect } from "vitest";

import { validateActivateSubscriptionInput, validateCreateSubscriptionInput } from "../modules/subscriptions/subscriptions.validation";
import { PLAN_LIMITS } from "../modules/subscriptions/subscriptions.types";

describe("Subscription Validation", () => {
  describe("validateActivateSubscriptionInput", () => {
    it("accepts 'free' (case-insensitive)", () => {
      const result = validateActivateSubscriptionInput({ plan: "free" });
      expect(result.plan).toBe("FREE");
    });

    it("accepts 'growth'", () => {
      const result = validateActivateSubscriptionInput({ plan: "growth" });
      expect(result.plan).toBe("GROWTH");
    });

    it("accepts 'pro'", () => {
      const result = validateActivateSubscriptionInput({ plan: "PRO" });
      expect(result.plan).toBe("PRO");
    });

    it("rejects invalid plan", () => {
      expect(() => validateActivateSubscriptionInput({ plan: "BASIC" })).toThrow();
    });

    it("rejects missing plan", () => {
      expect(() => validateActivateSubscriptionInput({})).toThrow();
    });

    it("rejects non-object input", () => {
      expect(() => validateActivateSubscriptionInput(null)).toThrow();
    });
  });

  describe("validateCreateSubscriptionInput", () => {
    it("accepts valid plan", () => {
      const result = validateCreateSubscriptionInput({ plan: "PREMIUM" });
      expect(result.plan).toBe("PREMIUM");
    });

    it("rejects invalid plan", () => {
      expect(() => validateCreateSubscriptionInput({ plan: "INVALID" })).toThrow();
    });
  });
});

describe("Plan Limits", () => {
  it("FREE plan has 10 product limit", () => {
    expect(PLAN_LIMITS.FREE.maxProducts).toBe(10);
  });

  it("GROWTH plan has 100 product limit", () => {
    expect(PLAN_LIMITS.GROWTH.maxProducts).toBe(100);
  });

  it("PRO plan has unlimited products", () => {
    expect(PLAN_LIMITS.PRO.maxProducts).toBe(-1);
  });

  it("FREE plan does not have analytics", () => {
    expect(PLAN_LIMITS.FREE.analytics).toBe(false);
  });

  it("GROWTH plan has analytics", () => {
    expect(PLAN_LIMITS.GROWTH.analytics).toBe(true);
  });

  it("FREE plan does not have flash sales", () => {
    expect(PLAN_LIMITS.FREE.flashSales).toBe(false);
  });

  it("GROWTH plan has flash sales", () => {
    expect(PLAN_LIMITS.GROWTH.flashSales).toBe(true);
  });

  it("PRO plan has all features", () => {
    expect(PLAN_LIMITS.PRO.analytics).toBe(true);
    expect(PLAN_LIMITS.PRO.flashSales).toBe(true);
    expect(PLAN_LIMITS.PRO.bundles).toBe(true);
    expect(PLAN_LIMITS.PRO.discounts).toBe(true);
    expect(PLAN_LIMITS.PRO.prioritySupport).toBe(true);
  });
});
