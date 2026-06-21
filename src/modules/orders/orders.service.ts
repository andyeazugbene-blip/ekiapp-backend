import type { NotificationType, Order, OrderStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";
import { notificationsService } from "../notifications/notifications.service";
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

// ─── Notification helpers ────────────────────────────────────────────

const statusLabels: Record<string, string> = {
  CONFIRMED: "confirmed",
  PROCESSING: "being processed",
  DISPATCHED: "dispatched",
  IN_TRANSIT: "in transit",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
};

async function sendOrderStatusNotification(order: { id: string; buyerId: string; orderNumber: string }, newStatus: OrderStatus): Promise<void> {
  const label = statusLabels[newStatus];
  if (!label) return;

  await notificationsService.enqueue({
    userId: order.buyerId,
    type: "ORDER_PAID" as NotificationType,
    title: `Order ${label}`,
    body: `Your order ${order.orderNumber} is now ${label}.`,
    data: { type: "order_status", orderId: order.id, orderNumber: order.orderNumber, status: newStatus },
  });
}

async function sendEarningsReleasedNotification(vendorId: string, orderId: string, amount: number, currency: string): Promise<void> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { userId: true, storeName: true },
  });
  if (!vendor) return;

  await notificationsService.enqueue({
    userId: vendor.userId,
    type: "BALANCE_CREDITED" as NotificationType,
    title: "Earnings Released",
    body: `${amount / 100} ${currency} in earnings have been released to your wallet for order.`,
    data: { type: "earnings_released", orderId },
  });
}

export const ordersService = {
  async listBuyerOrders(
    buyerId: string,
    query: ListBuyerOrdersQuery,
  ): Promise<{ items: Order[]; nextCursor: string | null }> {
    const items = await prisma.order.findMany({
      where: {
        buyerId,
        ...(query.status ? { status: query.status } : { status: { notIn: ["PENDING", "FAILED"] } }),
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
        ...(query.status ? { status: query.status } : { status: { notIn: ["PENDING", "FAILED"] } }),
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

    // Notify buyer about status change — awaited so Vercel serverless doesn't
    // terminate the function before the Expo push fetch completes.
    try {
      await sendOrderStatusNotification(order, newStatus);
    } catch (err) {
      logger.error("Failed to send order status notification", { orderId, newStatus, error: String(err) });
    }

    // When vendor marks order DELIVERED, release pending earnings to available balance
    if (newStatus === "DELIVERED") {
      try {
        const result = await releaseVendorEarnings(orderId);
        logger.info("Vendor earnings released on delivery", { orderId, vendorId: vendor.id, amount: result.amount });
        try {
          await sendEarningsReleasedNotification(vendor.id, orderId, result.amount, order.currency);
        } catch (e) {
          logger.error("Failed to send earnings released notification", { orderId, error: String(e) });
        }
      } catch (err) {
        logger.error("Failed to release vendor earnings on delivery", { orderId, error: String(err) });
      }
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

    // Release pending earnings to available balance (AWAITED � not fire-and-forget)
    try {
      const result = await releaseVendorEarnings(orderId);
      if (result.released && order.vendorId) {
        logger.info("Vendor earnings released on buyer completion", { orderId, vendorId: order.vendorId, amount: result.amount });
        try {
          await sendEarningsReleasedNotification(order.vendorId, orderId, result.amount, order.currency);
        } catch (e) {
          logger.error("Failed to send earnings released notification", { orderId, error: String(e) });
        }
      }
    } catch (err) {
      logger.error("Failed to release vendor earnings on buyer completion", { orderId, error: String(err) });
    }

    return updated;
  },

  async updateDeliveryAddress(buyerId: string, orderId: string, deliveryAddress: string): Promise<Order> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, buyerId: true, status: true },
    });

    if (!order) {
      throw new AppError("Order not found", 404);
    }
    if (order.buyerId !== buyerId) {
      throw new AppError("Forbidden", 403);
    }

    // Only allow address change before order is shipped
    const editableStatuses = ["PENDING", "PAID", "CONFIRMED", "PROCESSING"];
    if (!editableStatuses.includes(order.status)) {
      throw new AppError("Cannot change delivery address once order has been dispatched", 400);
    }

    return prisma.order.update({
      where: { id: orderId },
      data: { deliveryAddress },
      include: orderInclude,
    });
  },
};
