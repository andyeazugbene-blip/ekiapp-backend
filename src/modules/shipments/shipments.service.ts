import type { Shipment } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
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

    const shipment = await prisma.shipment.create({
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

    return prisma.shipment.update({
      where: { id: shipmentId },
      data,
    });
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
      orderBy: { createdAt: "desc" },
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
