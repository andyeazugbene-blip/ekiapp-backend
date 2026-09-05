/**
 * GET /api/admin/refunds — real refund history, combining two genuine
 * sources (never a client-side guess built from the generic order list,
 * and never a fabricated stat like "under review = 30% of requested" or
 * a synthetic "REF-001" id): AuditLog "ORDER_REFUNDED" rows for completed
 * refunds (with the ACTUAL refunded amount, correct even for a partial
 * refund) and open (PENDING/REJECTED) AdminApproval rows for refunds
 * still in the four-eyes queue. An APPROVED approval that has already
 * executed must not be double-counted — it's already covered by its
 * AuditLog row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: vi.fn() },
    adminApproval: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    vendor: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminListOrderRefunds } from "../modules/admin/admin-refunds.controller";

const m = vi.mocked(prisma, true);

function createMockRes(): Response & { statusCode: number; data: unknown } {
  const res = {
    statusCode: 0,
    data: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.data = data; return res; },
  };
  return res as unknown as Response & { statusCode: number; data: unknown };
}

beforeEach(() => vi.clearAllMocks());

describe("adminListOrderRefunds", () => {
  it("combines completed (AuditLog) and open (AdminApproval) refunds without double-counting an already-executed approval", async () => {
    m.auditLog.findMany.mockResolvedValue([
      { id: "log-1", entityId: "order-1", createdAt: new Date("2026-09-05T10:00:00Z"), metadata: { amount: 500, reason: "requested_by_customer", refundId: "re_1" } },
    ] as never);
    m.adminApproval.findMany.mockResolvedValue([
      { id: "appr-1", businessRefId: "order-2", amount: 2000, currency: null, reason: "large refund", status: "PENDING", requestedBy: { id: "u1", name: "Admin A", email: "a@test.com" }, decidedBy: null, createdAt: new Date("2026-09-05T09:00:00Z"), decidedAt: null },
    ] as never);
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "Eki-001", currency: "gbp", vendorId: "v1", buyer: { name: "Buyer One", email: "b1@test.com" } },
      { id: "order-2", orderNumber: "Eki-002", currency: "eur", vendorId: "v2", buyer: { name: "Buyer Two", email: "b2@test.com" } },
    ] as never);
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Vendor One" },
      { id: "v2", storeName: "Vendor Two" },
    ] as never);

    const res = createMockRes();
    await adminListOrderRefunds({} as Request, res as unknown as Response);

    const data = res.data as { items: any[]; counts: Record<string, number> };
    expect(data.items).toHaveLength(2);

    const completed = data.items.find((i) => i.orderId === "order-1");
    expect(completed).toMatchObject({ status: "COMPLETED", amount: 500, vendorName: "Vendor One", buyerName: "Buyer One" });

    const requested = data.items.find((i) => i.orderId === "order-2");
    expect(requested).toMatchObject({ status: "REQUESTED", amount: 2000, vendorName: "Vendor Two" });

    expect(data.counts).toEqual({ requested: 1, rejected: 0, completed: 1 });

    // Only PENDING/REJECTED approvals are queried — an already-executed
    // APPROVED one must never be fetched here (it's covered by AuditLog).
    expect(m.adminApproval.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["PENDING", "REJECTED"] } }),
    }));
  });

  it("shows a real empty state (empty array) when there is no refund activity at all — never invents rows", async () => {
    m.auditLog.findMany.mockResolvedValue([] as never);
    m.adminApproval.findMany.mockResolvedValue([] as never);
    m.order.findMany.mockResolvedValue([] as never);
    m.vendor.findMany.mockResolvedValue([] as never);

    const res = createMockRes();
    await adminListOrderRefunds({} as Request, res as unknown as Response);

    const data = res.data as { items: any[]; counts: Record<string, number> };
    expect(data.items).toEqual([]);
    expect(data.counts).toEqual({ requested: 0, rejected: 0, completed: 0 });
  });

  it("uses the actual refunded amount from AuditLog metadata, not the order's full total — correct for a partial refund", async () => {
    m.auditLog.findMany.mockResolvedValue([
      { id: "log-2", entityId: "order-3", createdAt: new Date(), metadata: { amount: 250, reason: "duplicate", refundId: "re_2" } },
    ] as never);
    m.adminApproval.findMany.mockResolvedValue([] as never);
    m.order.findMany.mockResolvedValue([
      { id: "order-3", orderNumber: "Eki-003", currency: "gbp", vendorId: null, buyer: { name: "Buyer Three", email: "b3@test.com" } },
    ] as never);
    m.vendor.findMany.mockResolvedValue([] as never);

    const res = createMockRes();
    await adminListOrderRefunds({} as Request, res as unknown as Response);

    const data = res.data as { items: any[] };
    expect(data.items[0].amount).toBe(250); // NOT the order's totalAmount — the actual refunded amount
  });
});
