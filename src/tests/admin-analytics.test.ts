/**
 * Phase B (admin reporting) — adminAnalyticsService had zero test coverage
 * despite being the platform's core admin dashboard numbers (GMV, Eki
 * revenue, retention rates, growth series). These are real computed
 * business metrics with real division-by-zero guards and real UTC
 * day-bucketing — worth exercising directly rather than trusting the UI
 * alone ever surfaced a bug in the math.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    payment: { aggregate: vi.fn(), findMany: vi.fn() },
    user: { count: vi.fn(), findMany: vi.fn() },
    vendor: { count: vi.fn(), findMany: vi.fn() },
    vendorSubscription: { findMany: vi.fn() },
    sellerPlan: { findMany: vi.fn() },
    wallet: { aggregate: vi.fn() },
    payoutRequest: { aggregate: vi.fn() },
    dispute: { count: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminAnalyticsService } from "../modules/admin/admin-analytics.service";

const m = vi.mocked(prisma, true) as any;

function emptyOverviewMocks() {
  m.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 0 }, _count: { _all: 0 } });
  m.payment.aggregate.mockResolvedValue({ _sum: { platformFeeAmount: 0 } });
  m.order.count.mockResolvedValue(0);
  m.user.count.mockResolvedValue(0);
  m.vendor.count.mockResolvedValue(0);
  m.order.findMany.mockResolvedValue([]);
  m.vendorSubscription.findMany.mockResolvedValue([]);
  m.wallet.aggregate.mockResolvedValue({ _sum: { pendingBalance: 0 } });
  m.payoutRequest.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  m.dispute.count.mockResolvedValue(0);
  m.order.groupBy.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  emptyOverviewMocks();
});

describe("adminAnalyticsService.getOverview — GMV, Eki revenue, avgOrderValue", () => {
  it("computes GMV and Eki revenue from real aggregates, avgOrderValue rounded from gmv/paidOrderCount", async () => {
    m.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 100000 }, _count: { _all: 3 } });
    m.payment.aggregate.mockResolvedValue({ _sum: { platformFeeAmount: 5000 } });

    const result = await adminAnalyticsService.getOverview();

    expect(result.gmv).toBe(100000);
    // 100000 / 3 = 33333.33... -> rounded
    expect(result.avgOrderValue).toBe(33333);
    expect(result.ekiRevenue).toBe(5000); // no active subscriptions in this test
  });

  it("returns 0 avgOrderValue when there are no paid orders — never divides by zero", async () => {
    m.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 0 }, _count: { _all: 0 } });

    const result = await adminAnalyticsService.getOverview();

    expect(result.avgOrderValue).toBe(0);
  });

  it("sums subscription revenue across distinct plans, deduped by plan id, and adds it to platform fee revenue", async () => {
    m.payment.aggregate.mockResolvedValue({ _sum: { platformFeeAmount: 1000 } });
    m.vendorSubscription.findMany.mockResolvedValue([
      { sellerPlanId: "plan-growth" },
      { sellerPlanId: "plan-growth" }, // two vendors on the same plan
      { sellerPlanId: "plan-pro" },
    ]);
    m.sellerPlan.findMany.mockResolvedValue([
      { id: "plan-growth", monthlyPriceCents: 2900 },
      { id: "plan-pro", monthlyPriceCents: 9900 },
    ]);

    const result = await adminAnalyticsService.getOverview();

    // Growth counted twice (2 real subscribers) + Pro once = 2900*2 + 9900
    expect(result.subscriptionRevenue).toBe(2900 * 2 + 9900);
    expect(result.ekiRevenue).toBe(1000 + 2900 * 2 + 9900);
    // Only the two distinct plan ids were looked up, never a third phantom one.
    expect(m.sellerPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: expect.arrayContaining(["plan-growth", "plan-pro"]) } } }),
    );
    expect((m.sellerPlan.findMany.mock.calls[0][0].where.id.in as string[])).toHaveLength(2);
  });

  it("skips the plan lookup entirely when no vendor has an active subscription with a real plan", async () => {
    m.vendorSubscription.findMany.mockResolvedValue([]);
    await adminAnalyticsService.getOverview();
    expect(m.sellerPlan.findMany).not.toHaveBeenCalled();
  });
});

describe("adminAnalyticsService.getOverview — buyer/vendor retention rates", () => {
  it("buyer retention: percentage of active buyers with more than one paid order", async () => {
    m.order.groupBy.mockResolvedValue([
      { buyerId: "b1", _count: { _all: 3 } }, // repeat
      { buyerId: "b2", _count: { _all: 1 } }, // one-time
      { buyerId: "b3", _count: { _all: 2 } }, // repeat
      { buyerId: "b4", _count: { _all: 1 } }, // one-time
    ]);

    const result = await adminAnalyticsService.getOverview();

    // 2 of 4 active buyers are repeat -> 50%
    expect(result.buyerRetentionRate).toBe(50);
  });

  it("buyer retention is 0 (not NaN) when there are no active buyers at all", async () => {
    m.order.groupBy.mockResolvedValue([]);
    const result = await adminAnalyticsService.getOverview();
    expect(result.buyerRetentionRate).toBe(0);
  });

  it("vendor retention: percentage of previous-30d vendors who also ordered in the current 30d window", async () => {
    // Current window (0-30d ago): vendor-1 and vendor-2 had a paid order.
    m.order.findMany
      .mockResolvedValueOnce([{ buyerId: "buyer-x" }]) // active buyers (distinct buyerId query) — irrelevant here
      .mockResolvedValueOnce([{ vendorId: "vendor-1" }, { vendorId: "vendor-2" }]) // active vendors (current 30d)
      .mockResolvedValueOnce([{ vendorId: "vendor-1" }, { vendorId: "vendor-3" }]); // previous 30-60d window

    const result = await adminAnalyticsService.getOverview();

    // Of the 2 vendors active in the PREVIOUS window, only vendor-1 also
    // appears in the CURRENT window -> 1/2 = 50%.
    expect(result.vendorRetentionRate).toBe(50);
  });

  it("vendor retention is 0 (not NaN) when no vendor was active in the previous window", async () => {
    m.order.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // previous window empty
    const result = await adminAnalyticsService.getOverview();
    expect(result.vendorRetentionRate).toBe(0);
  });
});

describe("adminAnalyticsService.getGrowth — real UTC day-bucketing", () => {
  it("buckets order GMV and count by the order's own createdAt day, never today's date", async () => {
    const dayBefore = new Date();
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    dayBefore.setUTCHours(15, 0, 0, 0); // any time that day — bucketing is by date, not time

    m.order.findMany.mockResolvedValue([
      { totalAmount: 500, createdAt: dayBefore },
      { totalAmount: 300, createdAt: dayBefore },
    ]);
    m.payment.findMany.mockResolvedValue([]);
    m.user.findMany.mockResolvedValue([]);
    m.vendor.findMany.mockResolvedValue([]);

    const result = await adminAnalyticsService.getGrowth("7d");

    const key = dayBefore.toISOString().slice(0, 10);
    const point = result.gmv.find((p) => p.date === key);
    expect(point?.value).toBe(800);
    const orderPoint = result.orders.find((p) => p.date === key);
    expect(orderPoint?.value).toBe(2);
  });

  it("always returns a fixed-length series covering every day in the range, even with zero activity", async () => {
    m.order.findMany.mockResolvedValue([]);
    m.payment.findMany.mockResolvedValue([]);
    m.user.findMany.mockResolvedValue([]);
    m.vendor.findMany.mockResolvedValue([]);

    const result = await adminAnalyticsService.getGrowth("30d");

    expect(result.gmv).toHaveLength(30);
    expect(result.range).toBe("30d");
    expect(result.gmv.every((p) => p.value === 0)).toBe(true);
  });

  it("revenue series is keyed by the payment's processedAt, and skips a payment with no processedAt rather than crashing", async () => {
    const today = new Date();
    today.setUTCHours(10, 0, 0, 0);
    m.order.findMany.mockResolvedValue([]);
    m.payment.findMany.mockResolvedValue([
      { platformFeeAmount: 200, processedAt: today },
      { platformFeeAmount: 999, processedAt: null }, // still pending — must be skipped, never counted
    ]);
    m.user.findMany.mockResolvedValue([]);
    m.vendor.findMany.mockResolvedValue([]);

    const result = await adminAnalyticsService.getGrowth("7d");

    const totalRevenue = result.revenue.reduce((sum, p) => sum + p.value, 0);
    expect(totalRevenue).toBe(200);
  });

  it("defaults to the 30d range when none is given", async () => {
    const result = await adminAnalyticsService.getGrowth();
    expect(result.gmv).toHaveLength(30);
  });
});
