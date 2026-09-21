/**
 * Phase B (admin reporting) — admin-analytics-phase2.service.ts (buyer/
 * vendor/order breakdown analytics) had zero test coverage despite real
 * percentage math (repeat purchase rate, vendor retention) and real
 * date-bucketing (weekKey's ISO-Monday-start calculation, a classic
 * off-by-one spot around Sunday).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    orderItem: { groupBy: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn(), groupBy: vi.fn() },
    vendor: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    product: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { getBuyerAnalytics, getVendorAnalytics, getOrderAnalytics } from "../modules/admin/admin-analytics-phase2.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.order.findMany.mockResolvedValue([]);
  m.order.groupBy.mockResolvedValue([]);
  m.order.count.mockResolvedValue(0);
  m.orderItem.groupBy.mockResolvedValue([]);
  m.orderItem.findMany.mockResolvedValue([]);
  m.user.findMany.mockResolvedValue([]);
  m.user.groupBy.mockResolvedValue([]);
  m.vendor.findMany.mockResolvedValue([]);
  m.vendor.count.mockResolvedValue(0);
  m.vendor.groupBy.mockResolvedValue([]);
  m.product.findMany.mockResolvedValue([]);
});

describe("getBuyerAnalytics — new vs returning, repeat purchase rate", () => {
  it("splits buyers in range into new (first order in-range) vs returning (had an earlier order too)", async () => {
    m.order.findMany
      .mockResolvedValueOnce([{ buyerId: "b1" }, { buyerId: "b2" }, { buyerId: "b3" }]) // buyers in range
      .mockResolvedValueOnce([{ buyerId: "b1" }]); // of those, b1 also ordered before the range

    const result = await getBuyerAnalytics("30d");

    expect(result.returningBuyers).toBe(1);
    expect(result.newBuyers).toBe(2); // 3 total - 1 returning
  });

  it("repeat purchase rate is a real percentage (2 decimal places), never NaN with zero active buyers", async () => {
    m.order.groupBy.mockResolvedValueOnce([]); // no buyer order counts at all
    const result = await getBuyerAnalytics("30d");
    expect(result.repeatPurchaseRate).toBe(0);
  });

  it("repeat purchase rate: buyers with more than one paid order, out of every buyer with at least one, rounded to 2dp", async () => {
    m.order.groupBy.mockResolvedValueOnce([
      { buyerId: "b1", _count: { _all: 2 } },
      { buyerId: "b2", _count: { _all: 1 } },
      { buyerId: "b3", _count: { _all: 5 } },
    ]);
    const result = await getBuyerAnalytics("30d");
    // 2 of 3 are repeat -> 66.67%
    expect(result.repeatPurchaseRate).toBe(66.67);
  });

  it("resolves real buyer names for the top-spenders list, falling back to Unknown only for a genuinely missing user row", async () => {
    m.order.groupBy
      .mockResolvedValueOnce([]) // buyerOrderCounts (repeat rate calc)
      .mockResolvedValueOnce([
        { buyerId: "b1", _sum: { totalAmount: 5000 }, _count: { _all: 2 }, _max: { createdAt: new Date("2026-01-01") } },
        { buyerId: "b-deleted", _sum: { totalAmount: 1000 }, _count: { _all: 1 }, _max: { createdAt: new Date("2026-01-02") } },
      ]); // topBuyerAgg
    m.user.findMany.mockResolvedValueOnce([{ id: "b1", name: "Amaka" }]); // b-deleted's user row is gone

    const result = await getBuyerAnalytics("30d");

    expect(result.topBuyers.find((b) => b.buyerId === "b1")?.name).toBe("Amaka");
    expect(result.topBuyers.find((b) => b.buyerId === "b-deleted")?.name).toBe("Unknown");
  });
});

describe("getVendorAnalytics — retention rate and vendors-with-no-orders", () => {
  it("vendorsWithNoOrders is the real gap between total vendors and vendors who actually sold in range", async () => {
    m.order.findMany.mockResolvedValueOnce([{ vendorId: "v1" }, { vendorId: "v2" }]); // vendorsWithOrdersInRange
    m.vendor.count.mockResolvedValueOnce(10);
    const result = await getVendorAnalytics("30d");
    expect(result.vendorsWithNoOrders).toBe(8);
    expect(result.totalVendors).toBe(10);
  });

  it("retention rate: percentage of previous-period vendors who also sold in the current period", async () => {
    m.order.findMany
      .mockResolvedValueOnce([{ vendorId: "v1" }, { vendorId: "v2" }]) // current period vendors
      .mockResolvedValueOnce([{ vendorId: "v1" }, { vendorId: "v3" }]); // previous period vendors
    const result = await getVendorAnalytics("30d");
    // Of 2 previous-period vendors, only v1 is also current -> 50%
    expect(result.vendorRetentionRate).toBe(50);
  });

  it("retention rate is 0, not NaN, when no vendor was active in the previous period", async () => {
    m.order.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await getVendorAnalytics("30d");
    expect(result.vendorRetentionRate).toBe(0);
  });

  it("resolves real vendor store names for both leaderboards, deduping the lookup across both aggregates", async () => {
    m.orderItem.groupBy
      .mockResolvedValueOnce([{ vendorId: "v1", _sum: { totalAmount: 9000 }, _count: { orderId: 3 } }]) // revenueAgg
      .mockResolvedValueOnce([{ vendorId: "v1", _count: { orderId: 3 }, _sum: { totalAmount: 9000 } }]); // orderAgg (same vendor)
    m.vendor.findMany.mockResolvedValueOnce([{ id: "v1", storeName: "Amaka's Kitchen" }]);

    const result = await getVendorAnalytics("30d");

    expect(result.topVendorsByRevenue[0].storeName).toBe("Amaka's Kitchen");
    expect(result.topVendorsByOrders[0].storeName).toBe("Amaka's Kitchen");
    // Only one vendor id looked up, even though it appears in both aggregates.
    expect((m.vendor.findMany.mock.calls[0][0].where.id.in as string[])).toHaveLength(1);
  });
});

describe("getOrderAnalytics — day/week/month bucketing and category fallback", () => {
  it("week bucketing anchors to Monday even for a Sunday order (classic off-by-one spot)", async () => {
    // 2026-01-04 is a Sunday.
    const sunday = new Date("2026-01-04T15:00:00.000Z");
    m.order.findMany.mockResolvedValueOnce([{ totalAmount: 1000, createdAt: sunday }]);

    const result = await getOrderAnalytics("30d");

    // The Monday of that week is 2025-12-29.
    expect(result.ordersByWeek).toHaveLength(1);
    expect(result.ordersByWeek[0].week).toBe("2025-12-29");
  });

  it("week bucketing anchors to Monday for a mid-week order too", async () => {
    // 2026-01-07 is a Wednesday, same week as the Sunday above.
    const wednesday = new Date("2026-01-07T09:00:00.000Z");
    m.order.findMany.mockResolvedValueOnce([{ totalAmount: 1000, createdAt: wednesday }]);

    const result = await getOrderAnalytics("30d");

    expect(result.ordersByWeek[0].week).toBe("2026-01-05"); // Monday of that week
  });

  it("avgOrderValue is rounded and never divides by zero with no orders", async () => {
    m.order.findMany.mockResolvedValueOnce([]);
    const result = await getOrderAnalytics("30d");
    expect(result.avgOrderValue).toBe(0);
  });

  it("avgOrderValue rounds the real gmv/count average", async () => {
    m.order.findMany.mockResolvedValueOnce([
      { totalAmount: 1000, createdAt: new Date() },
      { totalAmount: 2000, createdAt: new Date() },
      { totalAmount: 3000, createdAt: new Date() },
    ]);
    const result = await getOrderAnalytics("30d");
    expect(result.avgOrderValue).toBe(2000);
  });

  it("groups uncategorized products (no category, or the product row is gone) into a real Uncategorized bucket rather than dropping them", async () => {
    m.orderItem.findMany.mockResolvedValueOnce([
      { quantity: 2, totalAmount: 500, product: { category: null } },
      { quantity: 1, totalAmount: 300, product: null },
      { quantity: 3, totalAmount: 900, product: { category: "Grains" } },
    ]);

    const result = await getOrderAnalytics("30d");

    const uncategorized = result.topCategories.find((c) => c.category === "Uncategorized");
    expect(uncategorized?.totalQuantity).toBe(3); // 2 + 1
    expect(uncategorized?.totalRevenue).toBe(800); // 500 + 300
    expect(result.topCategories.find((c) => c.category === "Grains")?.totalRevenue).toBe(900);
  });

  it("top categories are sorted by revenue descending and capped at 10", async () => {
    m.orderItem.findMany.mockResolvedValueOnce(
      Array.from({ length: 12 }, (_, i) => ({ quantity: 1, totalAmount: (i + 1) * 100, product: { category: `Cat${i}` } })),
    );
    const result = await getOrderAnalytics("30d");
    expect(result.topCategories).toHaveLength(10);
    expect(result.topCategories[0].totalRevenue).toBeGreaterThan(result.topCategories[1].totalRevenue);
  });
});
