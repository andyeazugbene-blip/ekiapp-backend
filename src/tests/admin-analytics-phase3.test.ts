/**
 * Phase B (admin reporting) — admin-analytics-phase3.service.ts (payment/
 * escrow/payout/geographic analytics) had zero test coverage despite real
 * money-adjacent math: net adjustment amount (credits minus debits), and a
 * subtle "one address per buyer, default wins" dedup that silently
 * determines whether an order's GMV is geographically counted at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    payment: { aggregate: vi.fn() },
    order: { aggregate: vi.fn(), findMany: vi.fn() },
    walletTransaction: { groupBy: vi.fn() },
    payoutRequest: { aggregate: vi.fn(), findMany: vi.fn() },
    buyerAddress: { findMany: vi.fn() },
    vendor: { groupBy: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { getPaymentAnalytics, getGeographicAnalytics } from "../modules/admin/admin-analytics-phase3.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.payment.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: 0 } });
  m.order.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { totalAmount: 0 } });
  m.order.findMany.mockResolvedValue([]);
  m.walletTransaction.groupBy.mockResolvedValue([]);
  m.payoutRequest.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: 0 } });
  m.payoutRequest.findMany.mockResolvedValue([]);
  m.buyerAddress.findMany.mockResolvedValue([]);
  m.vendor.groupBy.mockResolvedValue([]);
});

describe("getPaymentAnalytics — escrow adjustments net amount", () => {
  it("nets ADJUSTMENT_CREDIT minus ADJUSTMENT_DEBIT, and sums both counts (never just one side)", async () => {
    m.walletTransaction.groupBy.mockResolvedValue([
      { type: "ADJUSTMENT_CREDIT", _count: { _all: 3 }, _sum: { amount: 5000 } },
      { type: "ADJUSTMENT_DEBIT", _count: { _all: 1 }, _sum: { amount: 1200 } },
    ]);

    const result = await getPaymentAnalytics("30d");

    expect(result.escrow.adjustments.amount).toBe(3800); // 5000 - 1200
    expect(result.escrow.adjustments.count).toBe(4); // 3 + 1
  });

  it("defaults every wallet transaction type to count:0/amount:0 when none exist yet — never crashes on a missing type", async () => {
    m.walletTransaction.groupBy.mockResolvedValue([]);
    const result = await getPaymentAnalytics("30d");
    expect(result.escrow.pendingCredits).toEqual({ count: 0, amount: 0 });
    expect(result.escrow.releases).toEqual({ count: 0, amount: 0 });
    expect(result.escrow.adjustments).toEqual({ count: 0, amount: 0 });
  });

  it("maps recentPayouts with the real vendor store name and falls back netAmount to the gross amount when net wasn't recorded", async () => {
    m.payoutRequest.findMany.mockResolvedValue([
      { id: "po-1", vendorId: "v1", amount: 10000, netAmount: null, status: "PAID", paidAt: new Date("2026-01-05"), createdAt: new Date("2026-01-01"), vendor: { id: "v1", storeName: "Amaka's Kitchen" } },
    ]);
    const result = await getPaymentAnalytics("30d");
    expect(result.payouts.recentPayouts[0].storeName).toBe("Amaka's Kitchen");
    expect(result.payouts.recentPayouts[0].netAmount).toBe(10000);
  });
});

describe("getGeographicAnalytics — default-address-wins, addressless buyers excluded", () => {
  it("uses a buyer's default address when they have more than one, never a non-default one", async () => {
    m.order.findMany.mockResolvedValue([{ buyerId: "b1", totalAmount: 5000 }]);
    // isDefault:desc ordering means the default row arrives first in the query result.
    m.buyerAddress.findMany.mockResolvedValue([
      { buyerId: "b1", country: "United Kingdom", city: "London", isDefault: true },
      { buyerId: "b1", country: "Nigeria", city: "Lagos", isDefault: false },
    ]);

    const result = await getGeographicAnalytics("30d");

    expect(result.ordersByCountry).toEqual([{ country: "United Kingdom", count: 1, gmv: 5000 }]);
  });

  it("silently excludes an order's GMV from geography when the buyer has no address on file at all — never crashes, never misattributes", async () => {
    m.order.findMany.mockResolvedValue([{ buyerId: "b-no-address", totalAmount: 5000 }]);
    m.buyerAddress.findMany.mockResolvedValue([]);

    const result = await getGeographicAnalytics("30d");

    expect(result.ordersByCountry).toEqual([]);
  });

  it("aggregates city GMV under the correct country even when two different countries share a city name", async () => {
    m.order.findMany.mockResolvedValue([
      { buyerId: "b1", totalAmount: 1000 },
      { buyerId: "b2", totalAmount: 2000 },
    ]);
    m.buyerAddress.findMany.mockResolvedValue([
      { buyerId: "b1", country: "United Kingdom", city: "Cambridge", isDefault: true },
      { buyerId: "b2", country: "United States", city: "Cambridge", isDefault: true },
    ]);

    const result = await getGeographicAnalytics("30d");

    const ukCambridge = result.ordersByCity.find((c) => c.country === "United Kingdom");
    const usCambridge = result.ordersByCity.find((c) => c.country === "United States");
    expect(ukCambridge?.gmv).toBe(1000);
    expect(usCambridge?.gmv).toBe(2000);
  });

  it("ordersByCountry is sorted by GMV descending and capped at 20", async () => {
    m.order.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({ buyerId: `b${i}`, totalAmount: (i + 1) * 100 })),
    );
    m.buyerAddress.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({ buyerId: `b${i}`, country: `Country${i}`, city: "City", isDefault: true })),
    );

    const result = await getGeographicAnalytics("30d");

    expect(result.ordersByCountry).toHaveLength(20);
    expect(result.ordersByCountry[0].gmv).toBeGreaterThan(result.ordersByCountry[1].gmv);
  });
});
