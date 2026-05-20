import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type { DashboardAlert, VendorDashboardData, VendorEarningsData } from "./vendors-dashboard.types";

function startOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
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

export const vendorDashboardService = {
  async getDashboard(userId: string): Promise<VendorDashboardData> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, storeName: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const wallet = await prisma.wallet.findUnique({
      where: { vendorId: vendor.id },
      select: { pendingBalance: true, availableBalance: true, currency: true },
    });

    // Get order counts for alerts
    const [actionableOrders, lowStockProducts, unreadMessages] = await Promise.all([
      prisma.orderItem.count({
        where: {
          vendorId: vendor.id,
          order: { status: { in: ["PAID", "CONFIRMED"] } },
        },
      }),
      prisma.product.count({
        where: { vendorId: vendor.id, isActive: true, stock: { lte: 5 } },
      }),
      prisma.message.count({
        where: {
          conversation: {
            OR: [{ participantA: userId }, { participantB: userId }],
          },
          senderId: { not: userId },
          readAt: null,
        },
      }),
    ]);

    const alerts: DashboardAlert[] = [];
    if (actionableOrders > 0) {
      alerts.push({ id: "a1", type: "order_action", label: "Orders requiring action", count: actionableOrders });
    }
    if (lowStockProducts > 0) {
      alerts.push({ id: "a2", type: "low_stock", label: "Low stock alerts", count: lowStockProducts });
    }
    if (unreadMessages > 0) {
      alerts.push({ id: "a3", type: "message", label: "Unread buyer messages", count: unreadMessages });
    }

    // Sales aggregation
    const todayStart = startOfDay();
    const weekStart = startOfWeek();
    const monthStart = startOfMonth();

    const [salesToday, salesThisWeek, salesThisMonth] = await Promise.all([
      this.sumVendorSales(vendor.id, todayStart),
      this.sumVendorSales(vendor.id, weekStart),
      this.sumVendorSales(vendor.id, monthStart),
    ]);

    // Best selling product
    const bestSelling = await prisma.orderItem.groupBy({
      by: ["productTitle"],
      where: { vendorId: vendor.id },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 1,
    });

    const totalOrders = await prisma.orderItem.findMany({
      where: { vendorId: vendor.id },
      select: { orderId: true },
      distinct: ["orderId"],
    });

    const totalProducts = await prisma.product.count({
      where: { vendorId: vendor.id, isActive: true },
    });

    return {
      greeting: "Welcome back,",
      storeName: vendor.storeName,
      alerts,
      earnings: {
        salesToday,
        salesThisWeek,
        salesThisMonth,
        pendingPayout: wallet?.pendingBalance ?? 0,
        currency: wallet?.currency ?? "usd",
      },
      insights: {
        bestSellingProduct: bestSelling[0]?.productTitle ?? null,
        totalOrders: totalOrders.length,
        totalProducts,
      },
    };
  },

  async getEarnings(userId: string): Promise<VendorEarningsData> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const wallet = await prisma.wallet.findUnique({
      where: { vendorId: vendor.id },
    });

    const todayStart = startOfDay();
    const weekStart = startOfWeek();
    const monthStart = startOfMonth();

    const [salesToday, salesThisWeek, salesThisMonth] = await Promise.all([
      this.sumVendorSales(vendor.id, todayStart),
      this.sumVendorSales(vendor.id, weekStart),
      this.sumVendorSales(vendor.id, monthStart),
    ]);

    // Total earnings = all PAYMENT_PENDING_CREDIT transactions
    const totalEarningsAgg = await prisma.walletTransaction.aggregate({
      where: { vendorId: vendor.id, type: "PAYMENT_PENDING_CREDIT" },
      _sum: { amount: true },
    });

    const recentPayouts = await prisma.payoutRequest.findMany({
      where: { vendorId: vendor.id },
      orderBy: CURSOR_ORDER_BY,
      take: 10,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
      },
    });

    return {
      totalEarnings: totalEarningsAgg._sum.amount ?? 0,
      pendingPayout: wallet?.pendingBalance ?? 0,
      availableBalance: wallet?.availableBalance ?? 0,
      salesToday,
      salesThisWeek,
      salesThisMonth,
      currency: wallet?.currency ?? "usd",
      recentPayouts,
    };
  },

  async sumVendorSales(vendorId: string, since: Date): Promise<number> {
    const result = await prisma.orderItem.aggregate({
      where: {
        vendorId,
        order: {
          status: { in: ["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED"] },
          createdAt: { gte: since },
        },
      },
      _sum: { totalAmount: true },
    });
    return result._sum.totalAmount ?? 0;
  },
};
