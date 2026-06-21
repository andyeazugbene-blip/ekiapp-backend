import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

async function getVendorId(userId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!vendor) throw new AppError("Vendor profile required", 403);
  return vendor.id;
}

/**
 * GET /api/vendors/me/buyers
 * Returns buyers who have purchased from this vendor.
 */
export async function listVendorBuyers(request: Request, response: Response): Promise<void> {
  const vendorId = await getVendorId(requireUserId(request));

  const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100);
  const cursor = typeof request.query.cursor === "string" ? request.query.cursor : undefined;

  // Find distinct buyers who have orders with items from this vendor
  const orders = await prisma.order.findMany({
    where: {
      vendorId,
      status: { notIn: ["PENDING", "FAILED", "CANCELLED"] },
    },
    select: {
      id: true,
      buyerId: true,
      totalAmount: true,
      createdAt: true,
      buyer: { select: { id: true, name: true, avatar: true, country: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Aggregate per buyer
  const buyerMap = new Map<string, {
    buyerId: string;
    name: string;
    country: string | null;
    totalOrders: number;
    totalSpent: number;
    lastOrderAt: Date;
    lastOrderId: string;
    avatar: string | null;
  }>();

  for (const order of orders) {
    const existing = buyerMap.get(order.buyerId);
    if (existing) {
      existing.totalOrders++;
      existing.totalSpent += order.totalAmount;
      if (order.createdAt > existing.lastOrderAt) {
        existing.lastOrderAt = order.createdAt;
        existing.lastOrderId = order.id;
      }
    } else {
      buyerMap.set(order.buyerId, {
        buyerId: order.buyerId,
        name: order.buyer.name,
        country: order.buyer.country,
        totalOrders: 1,
        totalSpent: order.totalAmount,
        lastOrderAt: order.createdAt,
        lastOrderId: order.id,
        avatar: order.buyer.avatar,
      });
    }
  }

  // Sort by totalSpent desc, paginate
  let buyers = [...buyerMap.values()].sort((a, b) => b.totalSpent - a.totalSpent);

  if (cursor) {
    const idx = buyers.findIndex((b) => b.buyerId === cursor);
    if (idx >= 0) buyers = buyers.slice(idx + 1);
  }

  const hasMore = buyers.length > limit;
  const items = buyers.slice(0, limit);
  const nextCursor = hasMore ? items[items.length - 1]?.buyerId ?? null : null;

  response.status(200).json({ items, nextCursor });
}

/**
 * GET /api/vendors/me/buyers/:id
 * Returns detailed buyer info for a specific buyer who purchased from this vendor.
 */
export async function getVendorBuyer(request: Request, response: Response): Promise<void> {
  const vendorId = await getVendorId(requireUserId(request));
  const buyerId = String(request.params.id ?? "");
  if (!buyerId) throw new AppError("Invalid buyer id", 400);

  // Verify this buyer has orders from this vendor
  const buyerOrders = await prisma.order.findMany({
    where: {
      vendorId,
      buyerId,
      status: { notIn: ["PENDING", "FAILED", "CANCELLED"] },
    },
    include: {
      items: { select: { productTitle: true, quantity: true, totalAmount: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (buyerOrders.length === 0) {
    throw new AppError("Buyer not found", 404);
  }

  const buyer = await prisma.user.findUnique({
    where: { id: buyerId },
    select: { id: true, name: true, country: true, avatar: true },
  });

  if (!buyer) throw new AppError("Buyer not found", 404);

  const totalOrders = await prisma.order.count({
    where: { vendorId, buyerId, status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } },
  });

  const totalSpentAgg = await prisma.order.aggregate({
    where: { vendorId, buyerId, status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } },
    _sum: { totalAmount: true },
  });

  // Top products
  const topProducts = await prisma.orderItem.groupBy({
    by: ["productTitle"],
    where: { vendorId, order: { buyerId, status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } } },
    _sum: { quantity: true, totalAmount: true },
    orderBy: { _sum: { totalAmount: "desc" } },
    take: 5,
  });

  response.status(200).json({
    buyer: {
      id: buyer.id,
      name: buyer.name,
      country: buyer.country,
      avatar: buyer.avatar,
      totalOrders,
      totalSpent: totalSpentAgg._sum?.totalAmount ?? 0,
      lastOrder: buyerOrders[0]?.createdAt ?? null,
      recentOrders: buyerOrders.slice(0, 5).map((o) => ({
        id: o.id,
        totalAmount: o.totalAmount,
        status: o.status,
        createdAt: o.createdAt,
        items: o.items,
      })),
      topProducts: topProducts.map((p) => ({
        productTitle: p.productTitle,
        totalQuantity: p._sum?.quantity ?? 0,
        totalAmount: p._sum?.totalAmount ?? 0,
      })),
    },
  });
}
