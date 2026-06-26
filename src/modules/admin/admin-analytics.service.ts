import { OrderStatus, UserRole } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";

const PAID_STATUSES: OrderStatus[] = [
  "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED",
];

const VALID_RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
type Range = keyof typeof VALID_RANGES;

function sinceDate(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildEmptyDays(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

export interface AnalyticsOverview {
  gmv: number;
  ekiRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  totalBuyers: number;
  totalVendors: number;
  activeBuyers30d: number;
  activeVendors30d: number;
  newBuyers: number;
  newVendors: number;
  buyerRetentionRate: number;
  vendorRetentionRate: number;
  subscriptionRevenue: number;
  escrowBalance: number;
  pendingPayouts: number;
  openDisputes: number;
  pendingVerifications: number;
  currency: string;
}

export interface GrowthPoint {
  date: string;
  value: number;
}

export interface GrowthSeries {
  gmv: GrowthPoint[];
  revenue: GrowthPoint[];
  orders: GrowthPoint[];
  buyers: GrowthPoint[];
  vendors: GrowthPoint[];
  range: Range;
}

export const adminAnalyticsService = {
  async getOverview(): Promise<AnalyticsOverview> {
    const thirtyDaysAgo = sinceDate(30);

    const [
      gmvAgg,
      platformFeeAgg,
      totalOrders,
      totalBuyers,
      totalVendors,
      activeBuyerOrders,
      activeVendorOrders,
      newBuyers,
      newVendors,
      activeSubscriptions,
      escrowAgg,
      pendingPayoutAgg,
      openDisputes,
      pendingVerifications,
    ] = await Promise.all([
      prisma.order.aggregate({
        where: { status: { in: PAID_STATUSES } },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      prisma.payment.aggregate({
        where: { status: "SUCCEEDED" },
        _sum: { platformFeeAmount: true },
      }),
      prisma.order.count({
        where: { status: { notIn: ["FAILED", "CANCELLED"] } },
      }),
      prisma.user.count({ where: { role: UserRole.BUYER } }),
      prisma.vendor.count(),
      prisma.order.findMany({
        where: { status: { in: PAID_STATUSES }, createdAt: { gte: thirtyDaysAgo } },
        select: { buyerId: true },
        distinct: ["buyerId"],
      }),
      prisma.order.findMany({
        where: {
          status: { in: PAID_STATUSES },
          createdAt: { gte: thirtyDaysAgo },
          vendorId: { not: null },
        },
        select: { vendorId: true },
        distinct: ["vendorId"],
      }),
      prisma.user.count({ where: { role: UserRole.BUYER, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.vendor.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.vendorSubscription.findMany({
        where: { status: "ACTIVE", sellerPlanId: { not: null } },
        select: { sellerPlanId: true },
      }),
      prisma.wallet.aggregate({ _sum: { pendingBalance: true } }),
      prisma.payoutRequest.aggregate({
        where: { status: "PENDING" },
        _sum: { amount: true },
      }),
      prisma.dispute.count({ where: { status: "OPEN" } }),
      prisma.vendor.count({ where: { verificationStatus: "PENDING" } }),
    ]);

    // Subscription MRR: sum plan prices for active subscriptions
    let subscriptionRevenue = 0;
    if (activeSubscriptions.length > 0) {
      const planIds = [...new Set(
        activeSubscriptions.map((s) => s.sellerPlanId).filter(Boolean) as string[],
      )];
      if (planIds.length > 0) {
        const plans = await prisma.sellerPlan.findMany({
          where: { id: { in: planIds } },
          select: { id: true, monthlyPriceCents: true },
        });
        const planPriceMap = new Map(plans.map((p) => [p.id, p.monthlyPriceCents]));
        for (const sub of activeSubscriptions) {
          subscriptionRevenue += planPriceMap.get(sub.sellerPlanId!) ?? 0;
        }
      }
    }

    // Buyer retention: % of buyers with >1 paid order out of all buyers with >=1
    const buyerOrderCounts = await prisma.order.groupBy({
      by: ["buyerId"],
      where: { status: { in: PAID_STATUSES } },
      _count: { _all: true },
    });
    const totalActiveBuyers = buyerOrderCounts.length;
    const repeatBuyers = buyerOrderCounts.filter((b) => b._count._all > 1).length;
    const buyerRetentionRate =
      totalActiveBuyers > 0 ? (repeatBuyers / totalActiveBuyers) * 100 : 0;

    // Vendor retention: vendors active in both current and previous 30d windows
    const sixtyDaysAgo = sinceDate(60);
    const previousPeriodVendors = await prisma.order.findMany({
      where: {
        status: { in: PAID_STATUSES },
        vendorId: { not: null },
        createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
      },
      select: { vendorId: true },
      distinct: ["vendorId"],
    });
    const currentVendorIds = new Set(activeVendorOrders.map((o) => o.vendorId));
    const previousVendorIds = previousPeriodVendors.map((o) => o.vendorId!);
    const retainedVendors = previousVendorIds.filter((id) => currentVendorIds.has(id)).length;
    const vendorRetentionRate =
      previousVendorIds.length > 0
        ? (retainedVendors / previousVendorIds.length) * 100
        : 0;

    const gmv = gmvAgg._sum.totalAmount ?? 0;
    const paidOrderCount = gmvAgg._count._all;
    const ekiRevenue = (platformFeeAgg._sum.platformFeeAmount ?? 0) + subscriptionRevenue;

    return {
      gmv,
      ekiRevenue,
      totalOrders,
      avgOrderValue: paidOrderCount > 0 ? Math.round(gmv / paidOrderCount) : 0,
      totalBuyers,
      totalVendors,
      activeBuyers30d: activeBuyerOrders.length,
      activeVendors30d: activeVendorOrders.length,
      newBuyers,
      newVendors,
      buyerRetentionRate: Math.round(buyerRetentionRate * 100) / 100,
      vendorRetentionRate: Math.round(vendorRetentionRate * 100) / 100,
      subscriptionRevenue,
      escrowBalance: escrowAgg._sum.pendingBalance ?? 0,
      pendingPayouts: pendingPayoutAgg._sum.amount ?? 0,
      openDisputes,
      pendingVerifications,
      currency: env.defaultCurrency,
    };
  },

  async getGrowth(range: Range = "30d"): Promise<GrowthSeries> {
    const days = VALID_RANGES[range];
    const since = sinceDate(days);
    const emptyDays = buildEmptyDays(days);

    const [orders, payments, newBuyerRows, newVendorRows] = await Promise.all([
      prisma.order.findMany({
        where: { status: { in: PAID_STATUSES }, createdAt: { gte: since } },
        select: { totalAmount: true, createdAt: true },
      }),
      prisma.payment.findMany({
        where: { status: "SUCCEEDED", processedAt: { gte: since } },
        select: { platformFeeAmount: true, processedAt: true },
      }),
      prisma.user.findMany({
        where: { role: UserRole.BUYER, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.vendor.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
    ]);

    const gmvByDay = new Map<string, number>();
    const ordersByDay = new Map<string, number>();
    const revByDay = new Map<string, number>();
    const buyersByDay = new Map<string, number>();
    const vendorsByDay = new Map<string, number>();

    for (const o of orders) {
      const key = dayKey(o.createdAt);
      gmvByDay.set(key, (gmvByDay.get(key) ?? 0) + o.totalAmount);
      ordersByDay.set(key, (ordersByDay.get(key) ?? 0) + 1);
    }
    for (const p of payments) {
      if (!p.processedAt) continue;
      const key = dayKey(p.processedAt);
      revByDay.set(key, (revByDay.get(key) ?? 0) + p.platformFeeAmount);
    }
    for (const b of newBuyerRows) {
      const key = dayKey(b.createdAt);
      buyersByDay.set(key, (buyersByDay.get(key) ?? 0) + 1);
    }
    for (const v of newVendorRows) {
      const key = dayKey(v.createdAt);
      vendorsByDay.set(key, (vendorsByDay.get(key) ?? 0) + 1);
    }

    return {
      gmv: emptyDays.map((d) => ({ date: d, value: gmvByDay.get(d) ?? 0 })),
      revenue: emptyDays.map((d) => ({ date: d, value: revByDay.get(d) ?? 0 })),
      orders: emptyDays.map((d) => ({ date: d, value: ordersByDay.get(d) ?? 0 })),
      buyers: emptyDays.map((d) => ({ date: d, value: buyersByDay.get(d) ?? 0 })),
      vendors: emptyDays.map((d) => ({ date: d, value: vendorsByDay.get(d) ?? 0 })),
      range,
    };
  },
};
