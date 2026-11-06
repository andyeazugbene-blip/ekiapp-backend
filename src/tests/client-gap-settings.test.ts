import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { incrementalEstimate } from "../modules/automation/automation-attribution.service";
import { isInHoldout } from "../modules/automation/automation.service";
import { hidePhoneNumbers } from "../modules/messages/messages.service";
import { calculateDeliveryFee } from "../shared/pricing";

describe("hidePhoneNumbers", () => {
  it("hides phone numbers in common formats", () => {
    for (const number of ["07700 900123", "+44 7700 900123", "+234 803 123 4567", "(020) 7946 0958", "0044-7700-900-123"]) {
      expect(hidePhoneNumbers(`call me on ${number} today`)).not.toMatch(/\d{3}/);
    }
  });

  it("leaves prices, quantities, dates and order codes alone", () => {
    for (const text of ["It costs 1250.50 for 20 bags", "Delivered on 12/11/2026", "Order EKI-1234567890", "2 x 5kg by 10 November", "See you 12-11-2026 10:30", "Ref 12.11.2026 10.30"]) {
      expect(hidePhoneNumbers(text)).toBe(text);
    }
  });
});

describe("isInHoldout", () => {
  it("is off at zero", () => {
    expect(isInHoldout("user", "abandoned_cart", 0)).toBe(false);
  });

  it("keeps a buyer in the same group", () => {
    expect(isInHoldout("user-1", "abandoned_cart", 50)).toBe(isInHoldout("user-1", "abandoned_cart", 50));
  });

  it("holds back about the chosen share", () => {
    let held = 0;
    for (let i = 0; i < 2000; i++) if (isInHoldout(`user-${i}`, "abandoned_cart", 20)) held++;
    expect(held).toBeGreaterThan(320);
    expect(held).toBeLessThan(480);
  });
});

describe("incrementalEstimate", () => {
  const assisted = [{ currency: "GBP", gross: 10000 }];

  it("shows nothing until both groups have enough buyers", () => {
    expect(incrementalEstimate({ exposedBuyers: 29, exposedConverted: 10, holdoutBuyers: 100, holdoutConverted: 5, assisted })).toBeNull();
    expect(incrementalEstimate({ exposedBuyers: 100, exposedConverted: 10, holdoutBuyers: 29, holdoutConverted: 5, assisted })).toBeNull();
  });

  it("counts only the revenue above natural conversion", () => {
    const result = incrementalEstimate({ exposedBuyers: 100, exposedConverted: 20, holdoutBuyers: 100, holdoutConverted: 5, assisted });
    expect(result?.byCurrency).toEqual([{ currency: "GBP", amount: 7500 }]);
  });

  it("never goes negative", () => {
    const result = incrementalEstimate({ exposedBuyers: 100, exposedConverted: 5, holdoutBuyers: 100, holdoutConverted: 20, assisted });
    expect(result?.byCurrency[0].amount).toBe(0);
  });
});

describe("calculateDeliveryFee", () => {
  it("keeps base plus weight by default", () => {
    expect(calculateDeliveryFee({ baseFeeAmount: 400, feePerKgAmount: 100, totalWeightGrams: 2500 })).toBe(700);
  });

  it("uses the higher of weight cost and minimum when chosen", () => {
    expect(calculateDeliveryFee({ baseFeeAmount: 400, feePerKgAmount: 100, totalWeightGrams: 2500, minimumFeeFormula: true })).toBe(400);
    expect(calculateDeliveryFee({ baseFeeAmount: 400, feePerKgAmount: 100, totalWeightGrams: 9500, minimumFeeFormula: true })).toBe(1000);
  });
});
