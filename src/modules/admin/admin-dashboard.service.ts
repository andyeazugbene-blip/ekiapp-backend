import { OrderStatus, UserRole } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import type {
  AdminAnalyticsData,
  AdminAuditLogItem,
  AdminDashboardData,
  ListAuditLogsQuery,
} from "./admin-dashboard.types";

function startOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const PAID_STATUSES: OrderStatus[] = [
  "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED",
];

export const adminDashboardService = {
  async getDashboard(): Promise<AdminDashboardData> {
    const weekStart = startOfWeek();

    const [
      totalVendors,
      pendingApprovals,
      suspendedVendors,
      totalOrders,
      pendingOrders,
      totalBuyers,
      newVendorsThisWeek,
      newOrdersThisWeek,
      revenueAgg,
    ] = await Promise.all([
      prisma.vendor.count(),
      prisma.vendor.count({ where: { verificationStatus: "PENDING" } }),
      prisma.vendor.count({ where: { isSuspended: true } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.user.count({ where: { role: UserRole.BUYER } }),
      prisma.vendor.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.order.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.payment.aggregate({
        where: { status: "SUCCEEDED" },
        _sum: { amount: true },
      }),
    ]);

    const activeVendors = totalVendors - suspendedVendors;

    return {
      totalVendors,
      pendingApprovals,
      activeVendors,
      suspendedVendors,
      totalOrders,
      pendingOrders,
      totalRevenue: revenueAgg._sum.amount ?? 0,
      totalBuyers,
      newVendorsThisWeek,
      newOrdersThisWeek,
      currency: env.defaultCurrency,
    };
  },

  async getAnalytics(): Promise<AdminAnalyticsData> {
    const todayStart = startOfDay();
    const weekStart = startOfWeek();
    const monthStart = startOfMonth();

    // Revenue aggregations
    const [revenueToday, revenueWeek, revenueMonth, revenueAll] = await Promise.all([
      prisma.payment.aggregate({
        where: { status: "SUCCEEDED", processedAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { status: "SUCCEEDED", processedAt: { gte: weekStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { status: "SUCCEEDED", processedAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { status: "SUCCEEDED" },
        _sum: { amount: true },
      }),
    ]);

    // Order status counts
    const [totalOrders, pendingOrders, paidOrders, completedOrders, failedOrders] =
      await Promise.all([
        prisma.order.count(),
        prisma.order.count({ where: { status: "PENDING" } }),
        prisma.order.count({ where: { status: { in: PAID_STATUSES } } }),
        prisma.order.count({ where: { status: "COMPLETED" } }),
        prisma.order.count({ where: { status: "FAILED" } }),
      ]);

    // Top vendors by revenue (from order items)
    const topVendorItems = await prisma.orderItem.groupBy({
      by: ["vendorId"],
      where: {
        order: { status: { in: PAID_STATUSES } },
      },
      _sum: { totalAmount: true },
      _count: { orderId: true },
      orderBy: { _sum: { totalAmount: "desc" } },
      take: 10,
    });

    const vendorIds = topVendorItems.map((v) => v.vendorId);
    const vendors = await prisma.vendor.findMany({
      where: { id: { in: vendorIds } },
      select: { id: true, storeName: true },
    });
    const vendorMap = new Map(vendors.map((v) => [v.id, v.storeName]));

    const topVendors = topVendorItems.map((v) => ({
      vendorId: v.vendorId,
      storeName: vendorMap.get(v.vendorId) ?? "Unknown",
      totalOrders: v._count.orderId,
      totalRevenue: v._sum.totalAmount ?? 0,
    }));

    // Growth
    const [newUsersThisWeek, newVendorsThisWeek, newOrdersThisWeek] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.vendor.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.order.count({ where: { createdAt: { gte: weekStart } } }),
    ]);

    return {
      revenue: {
        today: revenueToday._sum.amount ?? 0,
        thisWeek: revenueWeek._sum.amount ?? 0,
        thisMonth: revenueMonth._sum.amount ?? 0,
        allTime: revenueAll._sum.amount ?? 0,
        currency: env.defaultCurrency,
      },
      orders: {
        total: totalOrders,
        pending: pendingOrders,
        paid: paidOrders,
        completed: completedOrders,
        failed: failedOrders,
      },
      topVendors,
      growth: {
        newUsersThisWeek,
        newVendorsThisWeek,
        newOrdersThisWeek,
      },
    };
  },

  async listAuditLogs(query: ListAuditLogsQuery) {
    const items = await prisma.auditLog.findMany({
      where: {
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
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

    const actorIds = Array.from(new Set(items.map((item) => item.actorId).filter(Boolean)));
    const users = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true, role: true },
        })
      : [];
    const userMap = new Map(users.map((user) => [user.id, user]));

    const enriched: AdminAuditLogItem[] = items.map((item) => ({
      ...item,
      entityId: item.entityId ?? null,
      metadata: item.metadata ?? null,
      actor: userMap.get(item.actorId) ?? null,
    }));

    return { items: enriched, nextCursor };
  },
};
