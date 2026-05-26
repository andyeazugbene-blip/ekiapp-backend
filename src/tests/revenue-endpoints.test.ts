/**
 * Tests for vendor + admin revenue endpoints.
 *
 * - vendor revenue: data isolation, range validation, empty range zero series
 * - admin revenue: stripe/paystack split, empty range zero series, invalid range 400
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    wallet: { findUnique: vi.fn() },
    orderItem: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    paystackTransaction: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { getVendorRevenue } from "../modules/vendors/vendors-revenue.controller";
import { getAdminRevenue } from "../modules/admin/admin-revenue.controller";

const m = vi.mocked(prisma, true);

function createMockReq(opts: { user?: { id: string; role: string; email: string }; query?: Record<string, unknown> } = {}): Request {
  return {
    user: opts.user,
    query: opts.query ?? {},
  } as unknown as Request;
}

function createMockRes(): Response & { statusCode: number; data: unknown } {
  const res = {
    statusCode: 0,
    data: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.data = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; data: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getVendorRevenue", () => {
  it("401 when unauthenticated", async () => {
    const req = createMockReq({});
    const res = createMockRes();
    await expect(getVendorRevenue(req, res as unknown as Response)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("403 when authenticated user has no vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" } });
    const res = createMockRes();
    await expect(getVendorRevenue(req, res as unknown as Response)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("empty range returns zeroed series of 7 days for range=7d (no crash)", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", currency: "EUR" } as never);
    m.wallet.findUnique.mockResolvedValue({ pendingBalance: 0, availableBalance: 0, currency: "eur" } as never);
    m.orderItem.findMany.mockResolvedValue([] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" }, query: { range: "7d" } });
    const res = createMockRes();
    await getVendorRevenue(req, res as unknown as Response);

    const body = res.data as Record<string, unknown> & { series: { date: string; revenue: number; orders: number }[] };
    expect(body.range).toBe("7d");
    expect(body.totalRevenue).toBe(0);
    expect(body.orderCount).toBe(0);
    expect(body.averageOrderValue).toBe(0);
    expect(body.series).toHaveLength(7);
    for (const row of body.series) {
      expect(row.revenue).toBe(0);
      expect(row.orders).toBe(0);
    }
  });

  it("queries are filtered to vendor — data isolation", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", currency: "EUR" } as never);
    m.wallet.findUnique.mockResolvedValue(null);
    m.orderItem.findMany.mockResolvedValue([] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" } });
    const res = createMockRes();
    await getVendorRevenue(req, res as unknown as Response);

    const args = m.orderItem.findMany.mock.calls[0][0] as { where: { vendorId: string } };
    expect(args.where.vendorId).toBe("vendor-1");
  });

  it("aggregates per-day revenue and orderCount", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", currency: "EUR" } as never);
    m.wallet.findUnique.mockResolvedValue({ pendingBalance: 100, availableBalance: 200, currency: "eur" } as never);

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    m.orderItem.findMany.mockResolvedValue([
      { totalAmount: 1000, orderId: "ord-1", order: { createdAt: today } },
      { totalAmount: 500, orderId: "ord-1", order: { createdAt: today } }, // same order
      { totalAmount: 2000, orderId: "ord-2", order: { createdAt: today } },
    ] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" }, query: { range: "30d" } });
    const res = createMockRes();
    await getVendorRevenue(req, res as unknown as Response);

    const body = res.data as Record<string, unknown> & { series: { date: string; revenue: number; orders: number }[] };
    expect(body.totalRevenue).toBe(3500);
    expect(body.orderCount).toBe(2);
    expect(body.averageOrderValue).toBe(1750);
    expect(body.pendingBalance).toBe(100);
    expect(body.availableBalance).toBe(200);
  });

  it("invalid range returns 400 (consistent with admin endpoint)", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", currency: "EUR" } as never);
    m.wallet.findUnique.mockResolvedValue(null);
    m.orderItem.findMany.mockResolvedValue([] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" }, query: { range: "garbage" } });
    const res = createMockRes();
    await expect(getVendorRevenue(req, res as unknown as Response)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("missing range falls back to 30d", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", currency: "EUR" } as never);
    m.wallet.findUnique.mockResolvedValue(null);
    m.orderItem.findMany.mockResolvedValue([] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" }, query: {} });
    const res = createMockRes();
    await getVendorRevenue(req, res as unknown as Response);

    const body = res.data as { range: string; series: unknown[] };
    expect(body.range).toBe("30d");
    expect(body.series).toHaveLength(30);
  });
});

describe("getAdminRevenue", () => {
  it("invalid range returns 400", async () => {
    const req = createMockReq({ user: { id: "a1", role: "ADMIN", email: "a@a.com" }, query: { range: "1y" } });
    const res = createMockRes();
    await expect(getAdminRevenue(req, res as unknown as Response)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("empty period returns zero series and stripe/paystack splits", async () => {
    m.payment.findMany.mockResolvedValue([] as never);
    m.paystackTransaction.findMany.mockResolvedValue([] as never);

    const req = createMockReq({ user: { id: "a1", role: "ADMIN", email: "a@a.com" }, query: { range: "7d" } });
    const res = createMockRes();
    await getAdminRevenue(req, res as unknown as Response);

    const body = res.data as Record<string, unknown> & { series: unknown[] };
    expect(body.totalRevenue).toBe(0);
    expect(body.stripeRevenue).toBe(0);
    expect(body.paystackRevenue).toBe(0);
    expect(body.orderCount).toBe(0);
    expect(body.series).toHaveLength(7);
  });

  it("aggregates stripe + paystack with split", async () => {
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    m.payment.findMany.mockResolvedValue([
      { amount: 1500, processedAt: today, orderId: "ord-1" },
      { amount: 2500, processedAt: today, orderId: "ord-2" },
    ] as never);
    m.paystackTransaction.findMany.mockResolvedValue([
      { amount: 3000, updatedAt: today, orderId: "ord-3" },
    ] as never);

    const req = createMockReq({ user: { id: "a1", role: "ADMIN", email: "a@a.com" }, query: { range: "30d" } });
    const res = createMockRes();
    await getAdminRevenue(req, res as unknown as Response);

    const body = res.data as Record<string, unknown> & {
      series: { date: string; revenue: number; stripeRevenue: number; paystackRevenue: number; orders: number }[];
    };
    expect(body.totalRevenue).toBe(7000);
    expect(body.stripeRevenue).toBe(4000);
    expect(body.paystackRevenue).toBe(3000);
    expect(body.orderCount).toBe(3);

    // Find today's bucket
    const todayKey = today.toISOString().slice(0, 10);
    const bucket = body.series.find((s) => s.date === todayKey);
    expect(bucket).toBeDefined();
    expect(bucket!.revenue).toBe(7000);
    expect(bucket!.stripeRevenue).toBe(4000);
    expect(bucket!.paystackRevenue).toBe(3000);
    expect(bucket!.orders).toBe(3);
  });
});
