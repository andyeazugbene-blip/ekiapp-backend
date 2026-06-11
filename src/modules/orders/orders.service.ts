import type { Order, OrderStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";
import type { ListBuyerOrdersQuery, ListVendorOrdersQuery } from "./orders.types";
import { VENDOR_STATUS_TRANSITIONS, BUYER_STATUS_TRANSITIONS } from "./orders.types";

const orderInclude = {
  items: {
    include: {
      product: {
        select: { id: true, title: true, images: true, currency: true, priceInCents: true },
      },
    },
  },
  payment: {
    select: {
      id: true,
      status: true,
      stripePaymentIntentId: true,
      provider: true,
      platformFeeAmount: true,
      vendorEarningsAmount: true,
      sellerPlanId: true,
      sellerPlanSlug: true,
      commissionTierId: true,
      commissionBps: true,
      withdrawalFeeBps: true,
    },
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

    const items = await prisma.order.findMany({
      where: {
        vendorId: vendor.id,
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
      where: { id: orderId, vendorId: vendor.id },
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
      where: { id: orderId, vendorId: vendor.id },
      include: { items: { select: { vendorId: true } } },
    });

    if (!order) {
      throw new AppError("Order not found", 404);
    }

    const hasOnlyVendorItems = order.items.every((item) => item.vendorId === vendor.id);
    if (!hasOnlyVendorItems) {
      throw new AppError("Order contains items outside this vendor and cannot be managed from the vendor app", 409);
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

    // When vendor marks order DELIVERED, release pending earnings to available balance
    if (newStatus === "DELIVERED") {
      releaseVendorEarnings(orderId).catch(() => {});
    }

    return updated;
  },

  async completeBuyerOrder(buyerId: string, orderId: string): Promise<Order> {
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

    const allowedTransitions = BUYER_STATUS_TRANSITIONS[order.status] ?? [];
    if (!allowedTransitions.includes("COMPLETED")) {
      throw new AppError(
        `Cannot mark order as completed from ${order.status}`,
        400,
      );
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status: "COMPLETED", deliveredAt: new Date() },
      include: orderInclude,
    });

    // Release pending earnings to available balance
    releaseVendorEarnings(orderId).catch(() => {});

    return updated;
  },
};
