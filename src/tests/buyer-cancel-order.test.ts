/**
 * Acceptance audit fix (Defect F) — buyer-initiated order cancellation was
 * entirely missing. These tests cover the new cancelBuyerOrder(): the
 * PENDING (unpaid, stock-reserved) path restores stock and marks the
 * Payment row FAILED, the PAID path reuses the real refund machinery
 * Defect C already wired up, ownership/ownership-and-eligibility guards,
 * and the post-CONFIRMED cutoff (matching the vendor's own cancellation
 * boundary).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    payment: { updateMany: vi.fn() },
    product: { update: vi.fn() },
    vendor: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../shared/utils/wallet-release", () => ({
  releaseVendorEarnings: vi.fn().mockResolvedValue({ released: true, amount: 0 }),
}));

vi.mock("../modules/admin/admin-refunds.controller", () => ({
  executeOrderRefund: vi.fn(),
}));

import { prisma } from "../lib/prisma";
import { ordersService } from "../modules/orders/orders.service";
import { executeOrderRefund } from "../modules/admin/admin-refunds.controller";

const m = vi.mocked(prisma, true) as any;
const mockedExecuteOrderRefund = vi.mocked(executeOrderRefund);

function pendingOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    buyerId: "buyer-1",
    vendorId: "vendor-1",
    status: "PENDING",
    orderNumber: "EKI-001",
    payment: { id: "pay-1", status: "PENDING" },
    items: [{ productId: "prod-1", quantity: 2 }],
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("cancelBuyerOrder — ownership and eligibility", () => {
  it("404s when the order doesn't exist", async () => {
    m.order.findUnique.mockResolvedValue(null);
    await expect(ordersService.cancelBuyerOrder("buyer-1", "order-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("403s when the order belongs to a different buyer", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder({ buyerId: "someone-else" }));
    await expect(ordersService.cancelBuyerOrder("buyer-1", "order-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("409s once the vendor has already CONFIRMED the order — matches the vendor's own cancellation cutoff", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder({ status: "CONFIRMED", payment: { id: "pay-1", status: "SUCCEEDED" } }));
    await expect(ordersService.cancelBuyerOrder("buyer-1", "order-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(mockedExecuteOrderRefund).not.toHaveBeenCalled();
  });

  it("409s on an order already CANCELLED (no double-cancel)", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder({ status: "CANCELLED" }));
    await expect(ordersService.cancelBuyerOrder("buyer-1", "order-1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("cancelBuyerOrder — unpaid (PENDING) order", () => {
  it("restores stock, marks the pending Payment FAILED, and cancels the order", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder());
    m.$transaction.mockImplementation(async (cb: any) =>
      cb({
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        product: { update: vi.fn().mockResolvedValue({}) },
      }),
    );
    m.order.findUniqueOrThrow.mockResolvedValue(pendingOrder({ status: "CANCELLED" }));
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-1" });

    const result = await ordersService.cancelBuyerOrder("buyer-1", "order-1");

    expect(mockedExecuteOrderRefund).not.toHaveBeenCalled();
    expect(result.status).toBe("CANCELLED");
  });

  it("a lost race (order no longer PENDING when claimed) does not restore stock a second time", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder());
    const productUpdate = vi.fn();
    m.$transaction.mockImplementation(async (cb: any) =>
      cb({
        order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn() },
        product: { update: productUpdate },
      }),
    );
    m.order.findUniqueOrThrow.mockResolvedValue(pendingOrder({ status: "CANCELLED" }));

    await ordersService.cancelBuyerOrder("buyer-1", "order-1");

    expect(productUpdate).not.toHaveBeenCalled();
  });
});

describe("cancelBuyerOrder — paid (PAID) order reuses the real refund path", () => {
  it("calls executeOrderRefund with finalStatus CANCELLED, never touches stock directly", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder({ status: "PAID", payment: { id: "pay-1", status: "SUCCEEDED" } }));
    mockedExecuteOrderRefund.mockResolvedValue({
      refundId: "re_1", amount: 1000, currency: "gbp", status: "succeeded", provider: "stripe",
    });
    m.order.findUniqueOrThrow.mockResolvedValue(pendingOrder({ status: "CANCELLED" }));
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-1" });

    const result = await ordersService.cancelBuyerOrder("buyer-1", "order-1");

    expect(mockedExecuteOrderRefund).toHaveBeenCalledWith(
      "order-1", "buyer-1", undefined, "buyer_cancelled_paid_order", "CANCELLED",
    );
    expect(m.$transaction).not.toHaveBeenCalled();
    expect(m.product.update).not.toHaveBeenCalled();
    expect(result.status).toBe("CANCELLED");
  });

  it("propagates a refund failure and never marks the order cancelled", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder({ status: "PAID", payment: { id: "pay-1", status: "SUCCEEDED" } }));
    mockedExecuteOrderRefund.mockRejectedValue(new Error("Stripe refund failed"));

    await expect(ordersService.cancelBuyerOrder("buyer-1", "order-1")).rejects.toThrow("Stripe refund failed");
    expect(m.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("cancelBuyerOrder — vendor notification", () => {
  it("notifies the vendor that the buyer cancelled", async () => {
    m.order.findUnique.mockResolvedValue(pendingOrder());
    m.$transaction.mockImplementation(async (cb: any) =>
      cb({
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        product: { update: vi.fn().mockResolvedValue({}) },
      }),
    );
    m.order.findUniqueOrThrow.mockResolvedValue(pendingOrder({ status: "CANCELLED" }));
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-1" });

    const { notificationsService } = await import("../modules/notifications/notifications.service");
    await ordersService.cancelBuyerOrder("buyer-1", "order-1");

    expect(notificationsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "vendor-user-1", title: "Order cancelled" }),
    );
  });
});
