import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NAV-05 regression guard.
 *
 * Two bugs, same root cause (missing data.type on the notification payload
 * the frontend's tap-router matches against):
 *
 * 1. Delivery-confirm used to fire the vendor notification via
 *    notificationsService.enqueue() with `data: { orderId }` (no type — dead
 *    tap) AND, separately, pushNotifications.orderStatusUpdate() with a
 *    correctly-typed payload — a genuine duplicate push, one real, one dead.
 *    Fix: give the enqueue() call the real "order_status" type (the
 *    frontend already routes it correctly) and remove the redundant
 *    pushNotifications call outright, so there is exactly one push again,
 *    and it is the working one.
 * 2. Auto-release had the same missing-type dead tap with no duplicate to
 *    remove — just add the type.
 */
vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    vendor: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    deliveryOtp: { findUnique: vi.fn(), update: vi.fn() },
    smsDelivery: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn({
      order: { update: vi.fn() },
      user: { update: vi.fn() },
    })),
  },
}));

vi.mock("../lib/paystack", () => ({
  paystack: { refundTransaction: vi.fn(), isConfigured: vi.fn().mockReturnValue(false) },
}));

vi.mock("../lib/email-queue", () => ({
  enqueueEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue({ id: "notif-1" }) },
}));

vi.mock("../shared/utils/wallet-release", () => ({
  releaseVendorEarnings: vi.fn().mockResolvedValue({ released: true, amount: 1000 }),
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { escrowService } from "../modules/paystack/escrow.service";

const m = vi.mocked(prisma, true);
const mEnqueue = vi.mocked(notificationsService.enqueue);

beforeEach(() => {
  vi.clearAllMocks();
  // initiateVendorPayout() runs fire-and-forget after buyerConfirmDelivery —
  // give it nothing to find so it no-ops quietly rather than throwing noise.
  m.order.findUnique.mockResolvedValue(null as never);
});

describe("escrowService.buyerConfirmDelivery — NAV-05: single, correctly-routed vendor notification", () => {
  it("sends exactly one vendor notification, with data.type = 'order_status' (not the old type-less dead tap)", async () => {
    m.order.findUnique
      // 1st call inside buyerConfirmDelivery: the order lookup
      .mockResolvedValueOnce({
        id: "order-1", buyerId: "buyer-1", status: "DISPATCHED", escrowType: null, vendorId: "vendor-1", orderNumber: "ORD-1",
      } as never)
      // 2nd call: orderDetails for the buyer confirmation email
      .mockResolvedValueOnce({ orderNumber: "ORD-1", totalAmount: 5000, currency: "GBP", _count: { items: 1 } } as never)
      // Any further calls (from the fire-and-forget initiateVendorPayout) — no-op.
      .mockResolvedValue(null as never);
    m.order.update.mockResolvedValue({} as never);
    m.user.findUnique.mockResolvedValue({ email: "buyer@example.com", name: "Buyer" } as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-1" } as never);

    await escrowService.buyerConfirmDelivery("buyer-1", "order-1");

    expect(mEnqueue).toHaveBeenCalledTimes(1);
    expect(mEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "vendor-user-1",
        data: { type: "order_status", orderId: "order-1" },
      }),
    );
  });
});

describe("escrowService.processAutoReleases — NAV-05: routable data.type on the auto-release notification", () => {
  it("sends the vendor notification with data.type = 'order_status'", async () => {
    m.order.findMany.mockResolvedValueOnce([
      { id: "order-2", buyerId: "buyer-2", vendorId: "vendor-2", orderNumber: "ORD-2", totalAmount: 5000, vendorEarnings: 4000, currency: "GBP" },
    ] as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-2" } as never);

    const processed = await escrowService.processAutoReleases();

    expect(processed).toBe(1);
    expect(mEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "vendor-user-2",
        data: { type: "order_status", orderId: "order-2" },
      }),
    );
  });
});
