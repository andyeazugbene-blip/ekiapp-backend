/**
 * Tests for GET /api/vendors/me/buyers — vendor isolation, pagination, safe fields.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    order: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { listVendorBuyers } from "../modules/vendors/vendors-buyers.controller";

const m = vi.mocked(prisma, true);

function createMockReq(opts: { user?: { id: string; role: "BUYER" | "VENDOR" | "ADMIN"; email: string }; query?: Record<string, unknown> } = {}): Request {
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

describe("listVendorBuyers", () => {
  it("401 when unauthenticated", async () => {
    const req = createMockReq({}); // no user
    const res = createMockRes();
    await expect(listVendorBuyers(req, res as unknown as Response)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("403 when authenticated user has no vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    const req = createMockReq({ user: { id: "buyer-only", role: "BUYER", email: "b@b.com" } });
    const res = createMockRes();
    await expect(listVendorBuyers(req, res as unknown as Response)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns empty list when vendor has no buyers", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.order.findMany.mockResolvedValue([] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" } });
    const res = createMockRes();
    await listVendorBuyers(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect((res.data as { items: unknown[] }).items).toEqual([]);
  });

  it("aggregates buyers and exposes only safe fields", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.order.findMany.mockResolvedValue([
      {
        buyerId: "b1",
        totalAmount: 5000,
        createdAt: new Date("2026-05-01"),
        buyer: { id: "b1", name: "Alice", country: "IT" },
      },
      {
        buyerId: "b1",
        totalAmount: 3000,
        createdAt: new Date("2026-05-10"),
        buyer: { id: "b1", name: "Alice", country: "IT" },
      },
      {
        buyerId: "b2",
        totalAmount: 1000,
        createdAt: new Date("2026-04-15"),
        buyer: { id: "b2", name: "Bob", country: null },
      },
    ] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" } });
    const res = createMockRes();
    await listVendorBuyers(req, res as unknown as Response);

    const items = (res.data as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(2);

    // Sorted by totalSpent desc
    expect(items[0].buyerId).toBe("b1");
    expect(items[0].totalOrders).toBe(2);
    expect(items[0].totalSpent).toBe(8000);
    expect(items[0].lastOrderAt).toEqual(new Date("2026-05-10"));

    expect(items[1].buyerId).toBe("b2");
    expect(items[1].totalOrders).toBe(1);
    expect(items[1].totalSpent).toBe(1000);

    // Safe fields only — no email, no phone
    expect(items[0]).not.toHaveProperty("email");
    expect(items[0]).not.toHaveProperty("phone");
    expect(items[0]).toHaveProperty("name");
  });

  it("filters orders to this vendor only (no cross-vendor leak)", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.order.findMany.mockResolvedValue([] as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" } });
    const res = createMockRes();
    await listVendorBuyers(req, res as unknown as Response);

    expect(m.order.findMany).toHaveBeenCalledTimes(1);
    const args = m.order.findMany.mock.calls[0][0] as { where: { vendorId: string } };
    expect(args.where.vendorId).toBe("vendor-1");
  });

  it("respects limit query param", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    const orders = Array.from({ length: 5 }, (_, i) => ({
      buyerId: `b${i}`,
      totalAmount: 1000 * (5 - i),
      createdAt: new Date(),
      buyer: { id: `b${i}`, name: `Buyer ${i}`, country: null },
    }));
    m.order.findMany.mockResolvedValue(orders as never);

    const req = createMockReq({ user: { id: "u1", role: "VENDOR", email: "v@v.com" }, query: { limit: "3" } });
    const res = createMockRes();
    await listVendorBuyers(req, res as unknown as Response);

    const items = (res.data as { items: unknown[] }).items;
    expect(items).toHaveLength(3);
  });
});
