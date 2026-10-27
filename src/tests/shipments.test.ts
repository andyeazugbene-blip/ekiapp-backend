import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    shipment: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
vi.mock("../modules/events/events.service", () => ({
  EVENT_NAMES: { shipment_delayed: "shipment_delayed" },
  eventsService: { enqueueTransactional: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { eventsService } from "../modules/events/events.service";
import { shipmentsService } from "../modules/shipments/shipments.service";

const m = vi.mocked(prisma, true);

describe("shipmentsService.updateShipment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.shipment.updateMany.mockResolvedValue({ count: 1 } as never);
    m.shipment.findUniqueOrThrow.mockResolvedValue({ id: "shipment-1", status: "DELIVERED" } as never);
  });

  it("marks the order delivered, notifies buyer, and releases vendor earnings", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.shipment.findUnique.mockResolvedValue({
      id: "shipment-1",
      orderId: "order-1",
      vendorId: "vendor-1",
      status: "IN_TRANSIT",
      updatedAt: new Date("2026-10-27T10:00:00Z"),
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

  it("transactionally enqueues R24 only when the owned shipment enters DELAYED", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    const updatedAt = new Date("2026-10-27T10:00:00Z");
    m.shipment.findUnique.mockResolvedValue({ id: "shipment-1", orderId: "order-1", vendorId: "vendor-1", status: "IN_TRANSIT", updatedAt } as never);
    m.shipment.findUniqueOrThrow.mockResolvedValue({ id: "shipment-1", status: "DELAYED" } as never);
    m.order.findUnique.mockResolvedValue({ buyerId: "buyer-1", orderNumber: "EKI-1" } as never);

    await shipmentsService.updateShipment("vendor-user-1", "shipment-1", { status: "DELAYED" });

    expect(eventsService.enqueueTransactional).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "shipment_delayed", actorId: "vendor-user-1", entityType: "Shipment", entityId: "shipment-1",
      secondaryEntities: { orderId: "order-1", buyerId: "buyer-1", vendorId: "vendor-1" },
      payload: expect.objectContaining({ fromStatus: "IN_TRANSIT", toStatus: "DELAYED", orderNumber: "EKI-1" }),
    }), { dedupeKey: `shipment-delayed:shipment-1:${updatedAt.getTime()}`, schemaVersion: 1 });
  });

  it("does not enqueue another R24 event for an already delayed shipment", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.shipment.findUnique.mockResolvedValue({ id: "shipment-1", orderId: "order-1", vendorId: "vendor-1", status: "DELAYED", updatedAt: new Date() } as never);
    m.shipment.findUniqueOrThrow.mockResolvedValue({ id: "shipment-1", status: "DELAYED" } as never);
    await shipmentsService.updateShipment("vendor-user-1", "shipment-1", { status: "DELAYED" });
    expect(eventsService.enqueueTransactional).not.toHaveBeenCalled();
  });
});
