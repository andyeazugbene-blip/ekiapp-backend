/**
 * Acceptance audit fix (Defect C) — a vendor cancelling an order the buyer
 * had already paid for previously just flipped Order.status to CANCELLED
 * with no financial action at all: the buyer's money was never returned.
 * This proves updateVendorOrderStatus now triggers a real refund (reusing
 * executeOrderRefund, the same code the admin refund flow uses) exactly
 * when — and only when — the order's payment had actually succeeded, and
 * leaves every other transition (including cancelling an UNPAID order)
 * untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    order: { findUnique: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../shared/utils/wallet-release", () => ({
  releaseVendorEarnings: vi.fn().mockResolvedValue({ released: true, amount: 0 }),
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../modules/admin/admin-refunds.controller", () => ({
  executeOrderRefund: vi.fn(),
}));

import { prisma } from "../lib/prisma";
import { ordersService } from "../modules/orders/orders.service";
import { executeOrderRefund } from "../modules/admin/admin-refunds.controller";

const m = vi.mocked(prisma, true) as any;
const mockedExecuteOrderRefund = vi.mocked(executeOrderRefund);

const VENDOR = { id: "vendor-1", isSuspended: false };

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    status: "PAID",
    buyerId: "buyer-1",
    orderNumber: "EKI-001",
    currency: "gbp",
    items: [{ vendorId: "vendor-1" }],
    payment: { status: "SUCCEEDED" },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("updateVendorOrderStatus — CANCELLED with a paid order triggers a real refund", () => {
  it("calls executeOrderRefund with finalStatus CANCELLED, and skips the generic status write", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.order.findUnique.mockResolvedValue(baseOrder());
    mockedExecuteOrderRefund.mockResolvedValue({
      refundId: "re_1", amount: 1000, currency: "gbp", status: "succeeded", provider: "stripe",
    });
    m.order.findUniqueOrThrow.mockResolvedValue(baseOrder({ status: "CANCELLED" }));

    const result = await ordersService.updateVendorOrderStatus("user-1", "order-1", "CANCELLED" as any);

    expect(mockedExecuteOrderRefund).toHaveBeenCalledWith(
      "order-1", "user-1", undefined, "vendor_cancelled_paid_order", "CANCELLED",
    );
    expect(m.order.update).not.toHaveBeenCalled();
    expect(result.status).toBe("CANCELLED");
  });

  it("propagates a refund failure and never marks the order cancelled", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.order.findUnique.mockResolvedValue(baseOrder());
    mockedExecuteOrderRefund.mockRejectedValue(new Error("Stripe refund failed"));

    await expect(
      ordersService.updateVendorOrderStatus("user-1", "order-1", "CANCELLED" as any),
    ).rejects.toThrow("Stripe refund failed");

    expect(m.order.update).not.toHaveBeenCalled();
  });
});

describe("updateVendorOrderStatus — CANCELLED without a succeeded payment skips the refund entirely", () => {
  it("an unpaid (PENDING) order cancels via the plain status update, no refund call", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.order.findUnique.mockResolvedValue(baseOrder({ status: "PENDING", payment: { status: "PENDING" } }));
    m.order.update.mockResolvedValue(baseOrder({ status: "CANCELLED" }));

    const result = await ordersService.updateVendorOrderStatus("user-1", "order-1", "CANCELLED" as any);

    expect(mockedExecuteOrderRefund).not.toHaveBeenCalled();
    expect(m.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "order-1" }, data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
    expect(result.status).toBe("CANCELLED");
  });

  it("an order with no Payment row at all cancels via the plain status update, no refund call", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.order.findUnique.mockResolvedValue(baseOrder({ status: "PENDING", payment: null }));
    m.order.update.mockResolvedValue(baseOrder({ status: "CANCELLED" }));

    await ordersService.updateVendorOrderStatus("user-1", "order-1", "CANCELLED" as any);

    expect(mockedExecuteOrderRefund).not.toHaveBeenCalled();
  });
});

describe("updateVendorOrderStatus — non-CANCELLED transitions are unaffected", () => {
  it("PAID -> CONFIRMED never touches the refund path", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.order.findUnique.mockResolvedValue(baseOrder());
    m.order.update.mockResolvedValue(baseOrder({ status: "CONFIRMED" }));

    await ordersService.updateVendorOrderStatus("user-1", "order-1", "CONFIRMED" as any);

    expect(mockedExecuteOrderRefund).not.toHaveBeenCalled();
    expect(m.order.update).toHaveBeenCalled();
  });
});
