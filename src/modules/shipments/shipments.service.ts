import type { Shipment } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { pushNotifications } from "../../lib/push-notifications";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";
import type { CreateShipmentInput, ListShipmentsQuery, UpdateShipmentInput } from "./shipments.types";

export const shipmentsService = {
  async createShipment(
    userId: string,
    orderId: string,
    input: CreateShipmentInput,
  ): Promise<Shipment> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    // Verify vendor owns items in this order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { select: { vendorId: true } } },
    });
    if (!order) {
      throw new AppError("Order not found", 404);
    }
    const hasItems = order.items.some((item) => item.vendorId === vendor.id);
    if (!hasItems) {
      throw new AppError("Forbidden", 403);
    }

    // Check if shipment already exists
    const existing = await prisma.shipment.findUnique({ where: { orderId } });
    if (existing) {
      throw new AppError("Shipment already exists for this order", 409);
    }

    // Order must be in a dispatchable state
    if (!["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED"].includes(order.status)) {
      throw new AppError("Order is not in a shippable state", 400);
    }

    const shipment = await prisma.$transaction(async (tx) => {
      const created = await tx.shipment.create({
        data: {
          orderId,
          vendorId: vendor.id,
          trackingNumber: input.trackingNumber,
          carrier: input.carrier,
          status: "PROCESSING",
          estimatedDeliveryAt: input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null,
          dispatchedAt: new Date(),
        },
      });

      await tx.order.updateMany({
        where: { id: orderId, status: { in: ["PAID", "CONFIRMED", "PROCESSING"] } },
        data: { status: "DISPATCHED" },
      });

      return created;
    });

    return shipment;
  },

  async updateShipment(
    userId: string,
    shipmentId: string,
    input: UpdateShipmentInput,
  ): Promise<Shipment> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new AppError("Shipment not found", 404);
    }
    if (shipment.vendorId !== vendor.id) {
      throw new AppError("Forbidden", 403);
    }

    const data: Record<string, unknown> = {};
    if (input.trackingNumber !== undefined) data.trackingNumber = input.trackingNumber;
    if (input.carrier !== undefined) data.carrier = input.carrier;
    if (input.status !== undefined) {
      data.status = input.status;
      if (input.status === "DELIVERED") {
        data.deliveredAt = new Date();
      }
      if (input.status === "IN_TRANSIT" && !shipment.dispatchedAt) {
        data.dispatchedAt = new Date();
      }
    }
    if (input.estimatedDeliveryAt !== undefined) {
      data.estimatedDeliveryAt = input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null;
    }

    const nextOrderStatus =
      input.status === "IN_TRANSIT"
        ? "IN_TRANSIT"
        : input.status === "DELIVERED"
          ? "DELIVERED"
          : null;

    const updated = await prisma.$transaction(async (tx) => {
      const nextShipment = await tx.shipment.update({
        where: { id: shipmentId },
        data,
      });

      if (nextOrderStatus) {
        const orderUpdate = await tx.order.updateMany({
          where: {
            id: shipment.orderId,
            vendorId: vendor.id,
            status: { in: ["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT"] },
          },
          data: {
            status: nextOrderStatus,
            ...(nextOrderStatus === "DELIVERED" ? { deliveredAt: new Date() } : {}),
          },
        });

        if (orderUpdate.count === 1) {
          const order = await tx.order.findUnique({
            where: { id: shipment.orderId },
            select: { buyerId: true, orderNumber: true },
          });
          if (order) {
            await tx.notification.create({
              data: {
                userId: order.buyerId,
                type: "ADMIN_BROADCAST",
                title: "Order status updated",
                body: `Order ${order.orderNumber} is now ${nextOrderStatus.toLowerCase().replace("_", " ")}.`,
                data: { orderId: shipment.orderId, status: nextOrderStatus },
              },
            });
          }
        }
      }

      return nextShipment;
    });

    if (nextOrderStatus === "DELIVERED") {
      releaseVendorEarnings(shipment.orderId).catch(() => {});
    }

    if (nextOrderStatus) {
      const order = await prisma.order.findUnique({
        where: { id: shipment.orderId },
        select: { buyerId: true, orderNumber: true },
      });
      if (order) {
        pushNotifications.orderStatusUpdate(order.buyerId, order.orderNumber, nextOrderStatus);
      }
    }

    return updated;
  },

  async listVendorShipments(
    userId: string,
    query: ListShipmentsQuery,
  ): Promise<{ items: Shipment[]; nextCursor: string | null }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const items = await prisma.shipment.findMany({
      where: {
        vendorId: vendor.id,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },

  async getShipmentByOrder(userId: string, orderId: string): Promise<Shipment> {
    // Buyer can view shipment for their own order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { buyerId: true, items: { select: { vendorId: true } } },
    });
    if (!order) {
      throw new AppError("Order not found", 404);
    }

    // Allow buyer or vendor
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    const isVendor = vendor && order.items.some((item) => item.vendorId === vendor.id);
    const isBuyer = order.buyerId === userId;

    if (!isBuyer && !isVendor) {
      throw new AppError("Forbidden", 403);
    }

    const shipment = await prisma.shipment.findUnique({ where: { orderId } });
    if (!shipment) {
      throw new AppError("Shipment not found", 404);
    }

    return shipment;
  },
};
