/**
 * Phase 4.2 (test coverage for already-implemented features) — admin order
 * management and payment visibility (listOrders/getOrder/listPayments/
 * getPayment in admin-listings.service.ts) were real and wired to real
 * admin routes, but had zero dedicated test coverage. Exercises: enum
 * filter validation, cursor pagination, 404s, and the real (never
 * fabricated) vendor-name enrichment — Order/Payment only carry a scalar
 * vendorId, so the vendor's display name is looked up separately, and this
 * proves it's a genuine lookup (absent vendorId → null, not a guess).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findMany: vi.fn(), findUnique: vi.fn() },
    payment: { findMany: vi.fn(), findUnique: vi.fn() },
    vendor: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminListingsService, parsePagination } from "../modules/admin/admin-listings.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => vi.clearAllMocks());

describe("parsePagination — limit validation", () => {
  it("defaults to 20 when no limit is given", () => {
    expect(parsePagination({})).toEqual({ limit: 20, cursor: undefined });
  });

  it("rejects a limit above the max (100)", () => {
    expect(() => parsePagination({ limit: "500" })).toThrow(/invalid limit/i);
  });

  it("rejects a zero or negative limit", () => {
    expect(() => parsePagination({ limit: "0" })).toThrow(/invalid limit/i);
    expect(() => parsePagination({ limit: "-5" })).toThrow(/invalid limit/i);
  });

  it("rejects a non-integer limit", () => {
    expect(() => parsePagination({ limit: "12.5" })).toThrow(/invalid limit/i);
  });

  it("accepts a real cursor string", () => {
    expect(parsePagination({ cursor: "order-123" }).cursor).toBe("order-123");
  });
});

describe("listOrders — enum validation + cursor pagination", () => {
  it("rejects an invalid status filter", async () => {
    await expect(adminListingsService.listOrders({ status: "NOT_A_REAL_STATUS" })).rejects.toMatchObject({ statusCode: 400 });
    expect(m.order.findMany).not.toHaveBeenCalled();
  });

  it("filters by a valid status, uppercased", async () => {
    m.order.findMany.mockResolvedValue([]);
    await adminListingsService.listOrders({ status: "paid" });
    expect(m.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "PAID" } }));
  });

  it("lists everything with no filter when status is omitted", async () => {
    m.order.findMany.mockResolvedValue([]);
    await adminListingsService.listOrders({});
    expect(m.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it("returns a real nextCursor only when there are more results than the page size, and never leaks the extra row", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `order-${i}` }));
    m.order.findMany.mockResolvedValue(rows); // 4 rows for a limit-of-3 page (limit+1 fetched)
    const result = await adminListingsService.listOrders({ limit: "3" });

    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBe("order-3");
  });

  it("returns null nextCursor when everything fit on one page", async () => {
    m.order.findMany.mockResolvedValue([{ id: "order-0" }, { id: "order-1" }]);
    const result = await adminListingsService.listOrders({ limit: "20" });
    expect(result.nextCursor).toBeNull();
  });
});

describe("getOrder — 404 + real vendor-name enrichment", () => {
  it("404s for an order that doesn't exist", async () => {
    m.order.findUnique.mockResolvedValue(null);
    await expect(adminListingsService.getOrder("missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("enriches with the real vendor's store name via a genuine lookup", async () => {
    m.order.findUnique.mockResolvedValue({ id: "order-1", vendorId: "vendor-1" });
    m.vendor.findUnique.mockResolvedValue({ storeName: "Real Store Name", contactEmail: "a@b.com", country: "GB", city: "London", verificationStatus: "VERIFIED" });

    const result = await adminListingsService.getOrder("order-1");

    expect(m.vendor.findUnique).toHaveBeenCalledWith({ where: { id: "vendor-1" }, select: expect.any(Object) });
    expect(result.vendorName).toBe("Real Store Name");
  });

  it("never fabricates a vendor name — null when the order has no vendorId, no lookup attempted", async () => {
    m.order.findUnique.mockResolvedValue({ id: "order-1", vendorId: null });

    const result = await adminListingsService.getOrder("order-1");

    expect(m.vendor.findUnique).not.toHaveBeenCalled();
    expect(result.vendorName).toBeNull();
  });
});

describe("listPayments — enum validation + batched, deduped vendor-name enrichment", () => {
  it("rejects an invalid status filter", async () => {
    await expect(adminListingsService.listPayments({ status: "NOT_REAL" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("batches vendor lookups across multiple payments, deduping repeated vendor ids into one query", async () => {
    m.payment.findMany.mockResolvedValue([
      { id: "pay-1", order: { vendorId: "vendor-1" } },
      { id: "pay-2", order: { vendorId: "vendor-1" } }, // same vendor — must not cause a second lookup entry
      { id: "pay-3", order: { vendorId: "vendor-2" } },
    ]);
    m.vendor.findMany.mockResolvedValue([
      { id: "vendor-1", storeName: "Store A" },
      { id: "vendor-2", storeName: "Store B" },
    ]);

    const result = await adminListingsService.listPayments({});

    expect(m.vendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: expect.arrayContaining(["vendor-1", "vendor-2"]) } },
    }));
    expect((m.vendor.findMany.mock.calls[0][0].where.id.in as string[])).toHaveLength(2); // deduped, not 3
    expect((result.items[0] as any).vendorName).toBe("Store A");
    expect((result.items[2] as any).vendorName).toBe("Store B");
  });

  it("skips the vendor lookup entirely when no payment has an order/vendorId", async () => {
    m.payment.findMany.mockResolvedValue([{ id: "pay-1", order: null }]);
    await adminListingsService.listPayments({});
    expect(m.vendor.findMany).not.toHaveBeenCalled();
  });
});

describe("getPayment — 404 + real vendor-name enrichment", () => {
  it("404s for a payment that doesn't exist", async () => {
    m.payment.findUnique.mockResolvedValue(null);
    await expect(adminListingsService.getPayment("missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("enriches with the real vendor's store name", async () => {
    m.payment.findUnique.mockResolvedValue({ id: "pay-1", order: { vendorId: "vendor-1" } });
    m.vendor.findUnique.mockResolvedValue({ storeName: "Real Store" });

    const result = await adminListingsService.getPayment("pay-1");
    expect(result.vendorName).toBe("Real Store");
  });

  it("never fabricates a vendor name when the payment has no linked order/vendor", async () => {
    m.payment.findUnique.mockResolvedValue({ id: "pay-1", order: null });
    const result = await adminListingsService.getPayment("pay-1");
    expect(m.vendor.findUnique).not.toHaveBeenCalled();
    expect(result.vendorName).toBeNull();
  });
});
