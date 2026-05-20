import type { Order, OrderStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type { ListBuyerOrdersQuery, ListVendorOrdersQuery } from "./orders.types";
import { VENDOR_STATUS_TRANSITIONS } from "./orders.types";

const orderInclude = {
  items: {
    include: {
      product: {
        select: { id: true, title: true, images: true, currency: true, priceInCents: true },
      },
    },
  },
  payment: {
    select: { id: true, status: true, stripePaymentIntentId: true },
  },
  deliveryZone: {
    select: { id: true, name: true, country: true },
  },
};

export const ordersService = {
  async listBuyerOrders(
    buyerId: string,
    query: ListBuyerOrdersQuery,
  ): Promise<{ items: Order[]; nextCursor: string | null }> {
    const items = await prisma.order.findMany({
      where: {
        buyerId,
        ...(query.status ? { status: query.status } : {}),
      },
      include: orderInclude,
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

  async getBuyerOrder(buyerId: string, orderId: string): Promise<Order> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: orderInclude,
    });

    if (!order) {
      throw new AppError("Order not found", 404);
    }
    if (order.buyerId !== buyerId) {
      throw new AppError("Forbidden", 403);
    }

    return order;
  },

  async listVendorOrders(
    userId: string,
    query: ListVendorOrdersQuery,
  ): Promise<{ items: Order[]; nextCursor: string | null }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    // Find orders that contain items belonging to this vendor
    const orderIds = await prisma.orderItem.findMany({
      where: { vendorId: vendor.id },
      select: { orderId: true },
      distinct: ["orderId"],
    });

    const vendorOrderIds = orderIds.map((oi) => oi.orderId);

    if (vendorOrderIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const items = await prisma.order.findMany({
      where: {
        id: { in: vendorOrderIds },
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        ...orderInclude,
        buyer: {
          select: { id: true, name: true, email: true },
        },
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

  async getVendorOrder(userId: string, orderId: string): Promise<Order> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        ...orderInclude,
        buyer: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!order) {
      throw new AppError("Order not found", 404);
    }

    // Verify vendor owns items in this order
    const hasItems = order.items.some((item) => item.vendorId === vendor.id);
    if (!hasItems) {
      throw new AppError("Forbidden", 403);
    }

    return order;
  },

  async updateVendorOrderStatus(
    userId: string,
    orderId: string,
    newStatus: OrderStatus,
  ): Promise<Order> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

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

    const allowedTransitions = VENDOR_STATUS_TRANSITIONS[order.status] ?? [];
    if (!allowedTransitions.includes(newStatus)) {
      throw new AppError(
        `Cannot transition from ${order.status} to ${newStatus}`,
        400,
      );
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        ...(newStatus === "DELIVERED" ? { deliveredAt: new Date() } : {}),
      },
      include: orderInclude,
    });

    return updated;
  },
};
