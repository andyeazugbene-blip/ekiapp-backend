import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    shipment: { findUnique: vi.fn(), update: vi.fn() },
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(async (cb: any) =>
      cb({
        shipment: m.shipment,
        order: m.order,
      }),
    ),
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { shipmentsService } from "../modules/shipments/shipments.service";

const m = vi.mocked(prisma, true);

describe("shipmentsService.updateShipment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the order delivered, notifies buyer, and releases vendor earnings", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.shipment.findUnique.mockResolvedValue({
      id: "shipment-1",
      orderId: "order-1",
      vendorId: "vendor-1",
      dispatchedAt: new Date(),
    } as never);
    m.shipment.update.mockResolvedValue({ id: "shipment-1", status: "DELIVERED" } as never);
    m.order.updateMany.mockResolvedValue({ count: 1 } as never);
    m.order.findUnique.mockResolvedValue({ buyerId: "buyer-1", orderNumber: "EKI-1" } as never);

    const result = await shipmentsService.updateShipment("vendor-user-1", "shipment-1", { status: "DELIVERED" });

    expect(result).toMatchObject({ id: "shipment-1", status: "DELIVERED" });
    expect(m.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "order-1", vendorId: "vendor-1" }),
        data: expect.objectContaining({ status: "DELIVERED" }),
      }),
    );
    // Exactly one buyer notification (in-app + push) via notificationsService.enqueue —
    // not a second, separate raw Notification row inside the transaction.
    expect(notificationsService.enqueue).toHaveBeenCalledTimes(1);
    expect(notificationsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "buyer-1",
        data: expect.objectContaining({ orderId: "order-1", status: "DELIVERED" }),
      }),
    );
    // Vendor earnings are released on DISPATCHED (orders.service.ts), not here.
  });

  it("rejects vendors that do not own the shipment", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.shipment.findUnique.mockResolvedValue({ id: "shipment-1", vendorId: "vendor-2" } as never);

    await expect(
      shipmentsService.updateShipment("vendor-user-1", "shipment-1", { status: "IN_TRANSIT" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
