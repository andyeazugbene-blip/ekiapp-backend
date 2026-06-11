import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    shipment: { findUnique: vi.fn(), update: vi.fn() },
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    notification: { create: vi.fn() },
    $transaction: vi.fn(async (cb: any) =>
      cb({
        shipment: m.shipment,
        order: m.order,
        notification: m.notification,
      }),
    ),
  },
}));

vi.mock("../lib/push-notifications", () => ({
  pushNotifications: { orderStatusUpdate: vi.fn() },
}));

vi.mock("../shared/utils/wallet-release", () => ({
  releaseVendorEarnings: vi.fn().mockResolvedValue({ released: true, amount: 1000 }),
}));

import { pushNotifications } from "../lib/push-notifications";
import { prisma } from "../lib/prisma";
import { shipmentsService } from "../modules/shipments/shipments.service";
import { releaseVendorEarnings } from "../shared/utils/wallet-release";

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
    m.notification.create.mockResolvedValue({ id: "notification-1" } as never);

    const result = await shipmentsService.updateShipment("vendor-user-1", "shipment-1", { status: "DELIVERED" });

    expect(result).toMatchObject({ id: "shipment-1", status: "DELIVERED" });
    expect(m.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "order-1", vendorId: "vendor-1" }),
        data: expect.objectContaining({ status: "DELIVERED" }),
      }),
    );
    expect(m.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "buyer-1", data: { orderId: "order-1", status: "DELIVERED" } }),
      }),
    );
    expect(releaseVendorEarnings).toHaveBeenCalledWith("order-1");
    expect(pushNotifications.orderStatusUpdate).toHaveBeenCalledWith("buyer-1", "EKI-1", "DELIVERED");
  });

  it("rejects vendors that do not own the shipment", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.shipment.findUnique.mockResolvedValue({ id: "shipment-1", vendorId: "vendor-2" } as never);

    await expect(
      shipmentsService.updateShipment("vendor-user-1", "shipment-1", { status: "IN_TRANSIT" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
