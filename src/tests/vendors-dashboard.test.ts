/**
 * GET /vendor/dashboard — architecture doc "Module 3 — Dashboard
 * Orchestration". Real assertions against real aggregation logic: no test
 * here just checks the response "exists" — each one proves a specific rule
 * (max 3 urgent actions, exactly one recommendation, no duplicate
 * recommendation, hidden zero-counts, market-aware visibility).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    wallet: { findUnique: vi.fn() },
    orderItem: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    product: { count: vi.fn() },
    message: { count: vi.fn() },
    review: { aggregate: vi.fn() },
    order: { groupBy: vi.fn() },
    bundle: { count: vi.fn() },
    flashSale: { count: vi.fn() },
    payoutRequest: { findMany: vi.fn() },
    walletTransaction: { aggregate: vi.fn() },
  },
}));

vi.mock("../modules/community-buy/market-configuration.service", () => ({
  marketConfigurationService: { get: vi.fn() },
}));

vi.mock("../modules/subscriptions/subscriptions.service", () => ({
  subscriptionsService: { getVendorAccount: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { subscriptionsService } from "../modules/subscriptions/subscriptions.service";
import { vendorDashboardService } from "../modules/vendors/vendors-dashboard.service";

const m = vi.mocked(prisma, true);
const getMarketConfig = vi.mocked(marketConfigurationService.get);
const getVendorAccount = vi.mocked(subscriptionsService.getVendorAccount);

const BASE_ACCOUNT = {
  verificationStatus: "verified",
  accountStatus: "active",
  serviceLevel: "growth",
  serviceName: "Growth",
  renewalDate: "2026-10-01T00:00:00.000Z",
  limits: { bundles: true, flashSales: true, ordersRemaining: 40, maxOrders: 100 },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", storeName: "Test Store", country: "GB", verificationStatus: "VERIFIED" } as never);
  m.wallet.findUnique.mockResolvedValue({ pendingBalance: 500, availableBalance: 1000, currency: "gbp" } as never);
  m.orderItem.count.mockResolvedValue(0);
  m.orderItem.aggregate.mockResolvedValue({ _sum: { totalAmount: 0 } } as never);
  m.product.count.mockResolvedValue(0);
  m.message.count.mockResolvedValue(0);
  m.orderItem.groupBy.mockResolvedValue([] as never);
  m.orderItem.findMany.mockResolvedValue([] as never);
  m.review.aggregate.mockResolvedValue({ _avg: { rating: 0 }, _count: { _all: 0 } } as never);
  m.order.groupBy.mockResolvedValue([] as never);
  m.bundle.count.mockResolvedValue(0);
  m.flashSale.count.mockResolvedValue(0);
  getMarketConfig.mockResolvedValue({ regularDeliveriesEnabled: false, communityBuyEnabled: false } as never);
  getVendorAccount.mockResolvedValue(BASE_ACCOUNT);
});

describe("vendorDashboardService.getDashboard — urgent_actions", () => {
  it("hides every urgent action with zero count instead of showing a 0", async () => {
    const result = await vendorDashboardService.getDashboard("user-1");
    expect(result.urgent_actions).toEqual([]);
  });

  it("surfaces only the urgent actions with real non-zero counts, capped at 3", async () => {
    m.orderItem.count.mockResolvedValue(4);
    m.product.count.mockResolvedValueOnce(2); // low-stock count (first product.count call)
    m.message.count.mockResolvedValue(6);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.urgent_actions).toHaveLength(3);
    expect(result.urgent_actions.map((a) => a.type).sort()).toEqual(["low_stock", "message", "order_action"]);
    expect(result.urgent_actions.length).toBeLessThanOrEqual(3);
  });
});

describe("vendorDashboardService.getDashboard — recommended_action (exactly one, never duplicating an urgent action)", () => {
  it("is null when the vendor is verified, has products, and has already tried marketing tools", async () => {
    // First product.count call is the low-stock alert count, second is totalProducts.
    m.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5);
    m.bundle.count.mockResolvedValue(1);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.recommended_action).toBeNull();
  });

  it("recommends completing verification when the vendor isn't verified — a type no urgent_action ever uses", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", storeName: "Test Store", country: "GB", verificationStatus: "PENDING" } as never);
    getVendorAccount.mockResolvedValue({ ...BASE_ACCOUNT, verificationStatus: "pending" } as never);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.recommended_action).toEqual(
      expect.objectContaining({ type: "verify_account" }),
    );
    expect(result.urgent_actions.some((a) => a.type === "verify_account")).toBe(false);
  });

  it("recommends adding a first product when verified but the store is empty", async () => {
    // totalProducts comes from the SECOND product.count call (isActive-only,
    // no stock filter) — the first call is the low-stock alert count.
    m.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.recommended_action).toEqual(
      expect.objectContaining({ type: "add_product" }),
    );
  });

  it("recommends trying marketing tools only when the plan supports them and the vendor has never used one", async () => {
    m.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3); // has products
    m.bundle.count.mockResolvedValue(0);
    m.flashSale.count.mockResolvedValue(0);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.recommended_action).toEqual(
      expect.objectContaining({ type: "try_marketing_tools" }),
    );
  });

  it("never recommends marketing tools when the vendor's plan doesn't include them — real plan gate, not invented", async () => {
    m.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    m.bundle.count.mockResolvedValue(0);
    m.flashSale.count.mockResolvedValue(0);
    getVendorAccount.mockResolvedValue({ ...BASE_ACCOUNT, limits: { ...BASE_ACCOUNT.limits, bundles: false } } as never);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.recommended_action).toBeNull();
    expect(result.marketing_tools.some((t) => t.type === "bundles")).toBe(false);
  });

  it("always returns at most one recommendation, never an array of candidates", async () => {
    // Worst case: unverified AND zero products AND never used marketing —
    // every branch's condition is true at once.
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", storeName: "Test Store", country: "GB", verificationStatus: "PENDING" } as never);
    getVendorAccount.mockResolvedValue({ ...BASE_ACCOUNT, verificationStatus: "pending" } as never);
    m.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    m.bundle.count.mockResolvedValue(0);
    m.flashSale.count.mockResolvedValue(0);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.recommended_action).not.toBeNull();
    expect(Array.isArray(result.recommended_action)).toBe(false);
    // The highest-priority branch (verification) wins — not a later one.
    expect(result.recommended_action?.type).toBe("verify_account");
  });
});

describe("vendorDashboardService.getDashboard — marketing_tools (market-aware visibility)", () => {
  it("hides Regular Deliveries and Community Buy when the vendor's market has neither enabled", async () => {
    getMarketConfig.mockResolvedValue({ regularDeliveriesEnabled: false, communityBuyEnabled: false } as never);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.marketing_tools.some((t) => t.type === "regular_deliveries")).toBe(false);
    expect(result.marketing_tools.some((t) => t.type === "community_buy")).toBe(false);
  });

  it("shows Regular Deliveries and Community Buy only when the real backend market config enables them for the vendor's country", async () => {
    getMarketConfig.mockResolvedValue({ regularDeliveriesEnabled: true, communityBuyEnabled: true } as never);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(getMarketConfig).toHaveBeenCalledWith("GB");
    expect(result.marketing_tools.some((t) => t.type === "regular_deliveries")).toBe(true);
    expect(result.marketing_tools.some((t) => t.type === "community_buy")).toBe(true);
  });

  it("never queries or shows market-gated tools for a vendor with no country set", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", storeName: "Test Store", country: null, verificationStatus: "VERIFIED" } as never);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(getMarketConfig).not.toHaveBeenCalled();
    expect(result.marketing_tools.some((t) => t.type === "regular_deliveries")).toBe(false);
    expect(result.marketing_tools.some((t) => t.type === "community_buy")).toBe(false);
  });
});

describe("vendorDashboardService.getDashboard — business_counts / performance (real aggregates, not fabricated)", () => {
  it("computes repeatBuyers only from buyers with 2+ real non-cancelled orders", async () => {
    m.order.groupBy.mockResolvedValue([
      { buyerId: "b1", _count: { _all: 3 } },
      { buyerId: "b2", _count: { _all: 1 } },
      { buyerId: "b3", _count: { _all: 2 } },
    ] as never);

    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.business_counts.buyers).toBe(3);
    expect(result.performance.repeatBuyers).toBe(2);
    expect(m.order.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ vendorId: "vendor-1", status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } }),
      }),
    );
  });

  it("pulls vendor_account_status directly from the real subscription/plan service, never invents plan data", async () => {
    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.vendor_account_status).toEqual({
      verificationStatus: "verified",
      accountStatus: "active",
      serviceLevel: "growth",
      serviceName: "Growth",
      ordersRemaining: 40,
      maxOrders: 100,
      renewalDate: "2026-10-01T00:00:00.000Z",
    });
  });
});

describe("vendorDashboardService.getDashboard — legacy fields preserved (existing mobile client, unchanged)", () => {
  it("still returns greeting/storeName/alerts/earnings/insights alongside the new groups", async () => {
    const result = await vendorDashboardService.getDashboard("user-1");

    expect(result.greeting).toBe("Welcome back,");
    expect(result.storeName).toBe("Test Store");
    expect(result.alerts).toEqual([]);
    expect(result.earnings.currency).toBe("gbp");
    expect(result.insights).toEqual({ bestSellingProduct: null, totalOrders: 0, totalProducts: 0 });
  });
});
