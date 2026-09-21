/**
 * Acceptance audit fix (admin backend audit) — completeOrder() and
 * processStuckOrder() both mutate real financial state (payment status,
 * order status, vendor wallet pendingBalance) with zero audit trail, unlike
 * every other admin action that moves money (e.g. the refund flow). Also,
 * processStuckOrder() had no idempotency guard of its own — a second call
 * on an already-processed order relied entirely on WalletTransaction's DB
 * unique constraint throwing a raw, unhandled P2002 instead of a clean
 * error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    payment: { updateMany: vi.fn() },
    wallet: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    walletTransaction: { create: vi.fn() },
    vendor: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../shared/utils/wallet-release", () => ({
  releaseVendorEarnings: vi.fn().mockResolvedValue({ released: true, amount: 0 }),
}));

import { prisma } from "../lib/prisma";
import { adminOrdersService } from "../modules/admin/admin-orders.service";

const m = vi.mocked(prisma, true) as any;
const ADMIN_ID = "admin-1";

beforeEach(() => vi.clearAllMocks());

describe("completeOrder — audit logging", () => {
  it("records an audit entry with before/after state on success", async () => {
    const order = {
      id: "order-1", status: "PAID",
      payment: { id: "pay-1", status: "SUCCEEDED", vendorEarningsAmount: 1000, currency: "gbp" },
      items: [{ vendorId: "vendor-1" }],
    };
    m.$transaction.mockImplementation(async (cb: any) =>
      cb({
        order: { findUnique: vi.fn().mockResolvedValue(order), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      }),
    );

    await adminOrdersService.completeOrder("order-1", ADMIN_ID);

    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: ADMIN_ID,
        action: "admin.order.force_complete",
        entityType: "Order",
        entityId: "order-1",
        beforeState: { status: "PAID" },
        afterState: { status: "COMPLETED" },
      }),
    }));
  });

  it("does not audit-log when the order is not in a completable state (nothing happened)", async () => {
    const order = { id: "order-1", status: "PENDING", payment: null, items: [] };
    m.$transaction.mockImplementation(async (cb: any) =>
      cb({ order: { findUnique: vi.fn().mockResolvedValue(order), updateMany: vi.fn() } }),
    );

    await expect(adminOrdersService.completeOrder("order-1", ADMIN_ID)).rejects.toMatchObject({ statusCode: 400 });
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("processStuckOrder — audit logging + idempotency", () => {
  function pendingOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: "order-1", status: "PENDING", vendorId: "vendor-1",
      payment: { id: "pay-1", status: "PENDING", vendorEarningsAmount: 1000, currency: "gbp" },
      items: [{ vendorId: "vendor-1" }],
      checkout: { buyerId: "buyer-1" },
      ...overrides,
    };
  }

  it("records an audit entry with before/after state on success", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder());
    m.$transaction.mockImplementation(async (cb: any) =>
      cb({
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        wallet: {
          findUnique: vi.fn().mockResolvedValue({ id: "w1" }),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
        },
        walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-1" });
    m.wallet.findUnique.mockResolvedValue({ pendingBalance: 1000, availableBalance: 0 });

    await adminOrdersService.processStuckOrder("order-1", ADMIN_ID);

    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: ADMIN_ID,
        action: "admin.order.force_process",
        entityType: "Order",
        entityId: "order-1",
        beforeState: { status: "PENDING", paymentStatus: "PENDING" },
        afterState: { status: "PAID", paymentStatus: "SUCCEEDED", walletCredited: 1000 },
      }),
    }));
  });

  it("rejects up front (clean 409) when the payment already succeeded — never reaches the wallet-credit transaction", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder({ payment: { id: "pay-1", status: "SUCCEEDED", vendorEarningsAmount: 1000, currency: "gbp" } }));

    await expect(adminOrdersService.processStuckOrder("order-1", ADMIN_ID)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.$transaction).not.toHaveBeenCalled();
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  it("converts a raw P2002 (race: two concurrent force-process calls) into a clean 409, not an unhandled error", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder());
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    m.$transaction.mockRejectedValue(p2002);

    await expect(adminOrdersService.processStuckOrder("order-1", ADMIN_ID)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });
});
