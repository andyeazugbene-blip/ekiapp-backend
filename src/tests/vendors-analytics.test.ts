/**
 * Phase B (vendor reporting) — vendorAnalyticsService had zero test
 * coverage despite computing the numbers a vendor actually trusts to run
 * their business: estimated profit (with two real branches depending on
 * whether cost data is complete), top products, repeat/inactive buyer
 * classification, and the analytics feature gate itself. Worth testing
 * directly since a bug here means a vendor sees a wrong profit figure,
 * not just a wrong badge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    wallet: { findUnique: vi.fn() },
    order: { findMany: vi.fn(), groupBy: vi.fn() },
    orderItem: { findMany: vi.fn() },
    product: { findFirst: vi.fn() },
  },
}));
vi.mock("../modules/public-stores/public-stores.service", () => ({
  publicStoresService: { getDetailedAnalyticsForUser: vi.fn() },
}));
vi.mock("../modules/subscriptions/subscriptions.service", () => ({
  subscriptionsService: { checkFeatureAccess: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { publicStoresService } from "../modules/public-stores/public-stores.service";
import { subscriptionsService } from "../modules/subscriptions/subscriptions.service";
import { vendorAnalyticsService } from "../modules/vendors/vendors-analytics.service";

const m = vi.mocked(prisma, true) as any;
const VENDOR = { id: "vendor-1", storeSlug: "my-store", currency: "GBP" };

beforeEach(() => {
  vi.clearAllMocks();
  m.vendor.findUnique.mockResolvedValue(VENDOR);
  vi.mocked(subscriptionsService.checkFeatureAccess).mockResolvedValue(true as never);
  m.wallet.findUnique.mockResolvedValue({ pendingBalance: 0, availableBalance: 0, currency: "GBP" });
  m.order.findMany.mockResolvedValue([]);
  m.orderItem.findMany.mockResolvedValue([]);
  m.order.groupBy.mockResolvedValue([]);
  m.product.findFirst.mockResolvedValue(null);
  vi.mocked(publicStoresService.getDetailedAnalyticsForUser).mockResolvedValue(null as never);
});

describe("vendorAnalyticsService.getAnalytics — access gate", () => {
  it("403s when the vendor's plan doesn't include analytics", async () => {
    vi.mocked(subscriptionsService.checkFeatureAccess).mockResolvedValue(false as never);
    await expect(vendorAnalyticsService.getAnalytics("user-1", "month")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("403s when the caller has no vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(vendorAnalyticsService.getAnalytics("user-1", "month")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("vendorAnalyticsService.getAnalytics — estimated profit, two real branches", () => {
  it("with complete cost data on every item: profit = revenue - product cost - platform fees (never touches vendorEarnings)", async () => {
    m.orderItem.findMany.mockResolvedValue([
      { productId: "p1", productTitle: "Rice", quantity: 2, totalAmount: 10000, costAmount: 3000, orderId: "o1", product: { costAmount: 3000 } },
    ]);
    m.order.findMany.mockResolvedValue([
      { id: "o1", buyerId: "b1", status: "DELIVERED", totalAmount: 10000, vendorEarnings: 9000, subtotalAmount: 10000, deliveryFeeAmount: 0, platformFeeAmount: 500, createdAt: new Date() },
    ]);

    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");

    // totalRevenue = 10000 (cents), totalProductCost = 3000*2 = 6000, platformFees = 500
    // profit = 10000 - 6000 - 500 = 3500 cents = 35.00
    expect(result.summary.estimatedProfit).toBe(35);
    expect(result.summary.estimatedProfitAvailable).toBe(true);
  });

  it("with incomplete cost data (at least one item missing cost): falls back to vendorEarnings - known product cost, and flags estimatedProfitAvailable false", async () => {
    m.orderItem.findMany.mockResolvedValue([
      { productId: "p1", productTitle: "Rice", quantity: 1, totalAmount: 5000, costAmount: null, orderId: "o1", product: { costAmount: null } },
    ]);
    m.order.findMany.mockResolvedValue([
      { id: "o1", buyerId: "b1", status: "DELIVERED", totalAmount: 5000, vendorEarnings: 4500, subtotalAmount: 5000, deliveryFeeAmount: 0, platformFeeAmount: 500, createdAt: new Date() },
    ]);

    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");

    // hasCompleteCostData is false (missing cost) -> profit = vendorEarnings - totalProductCost(0) = 4500 cents = 45.00
    expect(result.summary.estimatedProfit).toBe(45);
    expect(result.summary.estimatedProfitAvailable).toBe(false);
  });

  it("estimatedProfitAvailable is false when there are simply no order items yet — never claims complete data from nothing", async () => {
    m.orderItem.findMany.mockResolvedValue([]);
    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");
    expect(result.summary.estimatedProfitAvailable).toBe(false);
  });
});

describe("vendorAnalyticsService.getAnalytics — top products", () => {
  it("aggregates by product across multiple order items, counts distinct orders not line items, and sorts by revenue desc", async () => {
    m.orderItem.findMany.mockResolvedValue([
      { productId: "p1", productTitle: "Rice", quantity: 1, totalAmount: 1000, costAmount: null, orderId: "o1", product: null },
      { productId: "p1", productTitle: "Rice", quantity: 2, totalAmount: 2000, costAmount: null, orderId: "o1", product: null }, // same order — orders count must stay 1
      { productId: "p2", productTitle: "Beans", quantity: 5, totalAmount: 5000, costAmount: null, orderId: "o2", product: null },
    ]);

    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");

    expect(result.topProducts[0].productId).toBe("p2"); // higher revenue first
    expect(result.topProducts[0].revenue).toBe(50);
    expect(result.topProducts[1].productId).toBe("p1");
    expect(result.topProducts[1].orders).toBe(1); // both p1 line items share order o1
    expect(result.topProducts[1].unitsSold).toBe(3); // 1 + 2
    expect(result.topProducts[1].revenue).toBe(30); // (1000+2000)/100
  });

  it("caps the list at 5 products even when more exist", async () => {
    m.orderItem.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        productId: `p${i}`, productTitle: `Product ${i}`, quantity: 1, totalAmount: (i + 1) * 100, costAmount: null, orderId: `o${i}`, product: null,
      })),
    );
    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");
    expect(result.topProducts).toHaveLength(5);
  });
});

describe("vendorAnalyticsService.getAnalytics — repeat/inactive buyer classification", () => {
  it("classifies a buyer as repeat only with more than one order across the vendor's full history, not just the selected range", async () => {
    // allVendorOrders (full history, unaffected by range) has 2 orders for buyer-1.
    m.order.findMany
      .mockResolvedValueOnce([]) // `orders` (in-range) — empty for this test
      .mockResolvedValueOnce([
        { buyerId: "buyer-1", createdAt: new Date() },
        { buyerId: "buyer-1", createdAt: new Date() },
      ]); // `allVendorOrders` (full history)

    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");

    expect(result.customerInsights.repeatBuyers).toBe(1);
  });

  it("flags a buyer inactive when their last order (across full history) is older than 30 days", async () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    m.order.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ buyerId: "buyer-old", createdAt: old }]);

    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");

    expect(result.customerInsights.inactiveBuyers30d).toBe(1);
  });

  it("does not flag a buyer inactive when their most recent order is within 30 days", async () => {
    const recent = new Date();
    m.order.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ buyerId: "buyer-recent", createdAt: recent }]);

    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");

    expect(result.customerInsights.inactiveBuyers30d).toBe(0);
  });
});

describe("vendorAnalyticsService.getAnalytics — insights ordering and truncation", () => {
  it("suggests sharing the store when there have been zero store visits", async () => {
    vi.mocked(publicStoresService.getDetailedAnalyticsForUser).mockResolvedValue({ opens: 0 } as never);
    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");
    expect(result.insights.some((i) => i.id === "share-store")).toBe(true);
  });

  it("never suggests sharing the store once it has real visits", async () => {
    vi.mocked(publicStoresService.getDetailedAnalyticsForUser).mockResolvedValue({ opens: 12 } as never);
    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");
    expect(result.insights.some((i) => i.id === "share-store")).toBe(false);
  });

  it("suggests a restock only for a real low-stock product, carrying its real id/title/stock", async () => {
    m.product.findFirst.mockResolvedValue({ id: "prod-9", title: "Palm Oil", stock: 3 });
    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");
    const restock = result.insights.find((i) => i.id === "restock-prod-9");
    expect(restock).toBeTruthy();
    expect(restock?.productId).toBe("prod-9");
    expect(restock?.body).toContain("3 left");
  });

  it("caps insights at 4 even when every condition fires", async () => {
    vi.mocked(publicStoresService.getDetailedAnalyticsForUser).mockResolvedValue({ opens: 0, checkoutStarts: 10, completedOrders: 1 } as never);
    m.product.findFirst.mockResolvedValue({ id: "prod-9", title: "Palm Oil", stock: 1 });
    m.order.findMany
      .mockResolvedValueOnce([{ id: "o1", buyerId: "b1", status: "PAID", totalAmount: 100, vendorEarnings: 90, subtotalAmount: 100, deliveryFeeAmount: 0, platformFeeAmount: 10, createdAt: new Date() }])
      .mockResolvedValueOnce([{ buyerId: "b1", createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) }]); // inactive -> also fires "review-buyers" and "inactive-buyers"

    const result = await vendorAnalyticsService.getAnalytics("user-1", "month");

    expect(result.insights.length).toBeLessThanOrEqual(4);
  });
});
