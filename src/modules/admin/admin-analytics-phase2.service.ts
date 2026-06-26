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

function weekKey(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return dayKey(d);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function parseRange(raw: unknown): { range: Range; days: number } {
  const value = typeof raw === "string" && raw in VALID_RANGES ? raw : "30d";
  return { range: value as Range, days: VALID_RANGES[value as Range] };
}

// ─── BUYER ANALYTICS ────────────────────────────────────────────────────────

export interface BuyerAnalytics {
  newBuyers: number;
  returningBuyers: number;
  repeatPurchaseRate: number;
  avgOrdersPerBuyer: number;
  topBuyers: {
    buyerId: string;
    name: string;
    totalOrders: number;
    totalSpend: number;
    lastOrderDate: string | null;
  }[];
  buyerLocations: { country: string; count: number }[];
  currency: string;
}

export async function getBuyerAnalytics(rawRange: unknown): Promise<BuyerAnalytics> {
  const { days } = parseRange(rawRange);
  const since = sinceDate(days);

  // Distinct buyers with paid orders in range
  const buyersInRange = await prisma.order.findMany({
    where: { status: { in: PAID_STATUSES }, createdAt: { gte: since } },
    select: { buyerId: true },
    distinct: ["buyerId"],
  });
  const buyerIdsInRange = buyersInRange.map((b) => b.buyerId);

  // Returning = had paid order BEFORE range too
  const returningBuyerRows = buyerIdsInRange.length > 0
    ? await prisma.order.findMany({
        where: {
          status: { in: PAID_STATUSES },
          createdAt: { lt: since },
          buyerId: { in: buyerIdsInRange },
        },
        select: { buyerId: true },
        distinct: ["buyerId"],
      })
    : [];
  const returningBuyers = returningBuyerRows.length;
  const newBuyers = buyerIdsInRange.length - returningBuyers;

  // Repeat purchase rate (all-time): buyers with >1 paid order / buyers with >=1
  const buyerOrderCounts = await prisma.order.groupBy({
    by: ["buyerId"],
    where: { status: { in: PAID_STATUSES } },
    _count: { _all: true },
  });
  const totalActiveBuyers = buyerOrderCounts.length;
  const repeatBuyers = buyerOrderCounts.filter((b) => b._count._all > 1).length;
  const repeatPurchaseRate = totalActiveBuyers > 0
    ? Math.round((repeatBuyers / totalActiveBuyers) * 10000) / 100
    : 0;

  // Avg orders per buyer in range
  const paidOrdersInRange = await prisma.order.count({
    where: { status: { in: PAID_STATUSES }, createdAt: { gte: since } },
  });
  const avgOrdersPerBuyer = buyerIdsInRange.length > 0
    ? Math.round((paidOrdersInRange / buyerIdsInRange.length) * 100) / 100
    : 0;

  // Top 10 buyers by spend in range
  const topBuyerAgg = await prisma.order.groupBy({
    by: ["buyerId"],
    where: { status: { in: PAID_STATUSES }, createdAt: { gte: since } },
    _sum: { totalAmount: true },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _sum: { totalAmount: "desc" } },
    take: 10,
  });
  const topBuyerIds = topBuyerAgg.map((b) => b.buyerId);
  const topBuyerUsers = topBuyerIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: topBuyerIds } },
        select: { id: true, name: true },
      })
    : [];
  const userNameMap = new Map(topBuyerUsers.map((u) => [u.id, u.name]));

  const topBuyers = topBuyerAgg.map((b) => ({
    buyerId: b.buyerId,
    name: userNameMap.get(b.buyerId) ?? "Unknown",
    totalOrders: b._count._all,
    totalSpend: b._sum.totalAmount ?? 0,
    lastOrderDate: b._max.createdAt?.toISOString() ?? null,
  }));

  // Buyer locations by country
  const buyerCountries = await prisma.user.groupBy({
    by: ["country"],
    where: { role: UserRole.BUYER, country: { not: null } },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 20,
  });
  const buyerLocations = buyerCountries
    .filter((c) => c.country)
    .map((c) => ({ country: c.country!, count: c._count.id }));

  return {
    newBuyers,
    returningBuyers,
    repeatPurchaseRate,
    avgOrdersPerBuyer,
    topBuyers,
    buyerLocations,
    currency: env.defaultCurrency,
  };
}

// ─── VENDOR ANALYTICS ───────────────────────────────────────────────────────

export interface VendorAnalytics {
  topVendorsByRevenue: {
    vendorId: string;
    storeName: string;
    totalRevenue: number;
    totalOrders: number;
  }[];
  topVendorsByOrders: {
    vendorId: string;
    storeName: string;
    totalOrders: number;
    totalRevenue: number;
  }[];
  vendorsWithNoOrders: number;
  vendorLocations: { country: string; city: string | null; count: number }[];
  vendorRetentionRate: number;
  totalVendors: number;
  currency: string;
}

export async function getVendorAnalytics(rawRange: unknown): Promise<VendorAnalytics> {
  const { days } = parseRange(rawRange);
  const since = sinceDate(days);
  const previousSince = sinceDate(days * 2);

  // Top vendors by revenue (from OrderItem for accuracy)
  const revenueAgg = await prisma.orderItem.groupBy({
    by: ["vendorId"],
    where: { order: { status: { in: PAID_STATUSES }, createdAt: { gte: since } } },
    _sum: { totalAmount: true },
    _count: { orderId: true },
    orderBy: { _sum: { totalAmount: "desc" } },
    take: 10,
  });

  // Top vendors by order count
  const orderAgg = await prisma.orderItem.groupBy({
    by: ["vendorId"],
    where: { order: { status: { in: PAID_STATUSES }, createdAt: { gte: since } } },
    _count: { orderId: true },
    _sum: { totalAmount: true },
    orderBy: { _count: { orderId: "desc" } },
    take: 10,
  });

  // Resolve vendor names
  const allVendorIds = [
    ...new Set([
      ...revenueAgg.map((v) => v.vendorId),
      ...orderAgg.map((v) => v.vendorId),
    ]),
  ];
  const vendors = allVendorIds.length > 0
    ? await prisma.vendor.findMany({
        where: { id: { in: allVendorIds } },
        select: { id: true, storeName: true },
      })
    : [];
  const vendorNameMap = new Map(vendors.map((v) => [v.id, v.storeName]));

  const topVendorsByRevenue = revenueAgg.map((v) => ({
    vendorId: v.vendorId,
    storeName: vendorNameMap.get(v.vendorId) ?? "Unknown",
    totalRevenue: v._sum.totalAmount ?? 0,
    totalOrders: v._count.orderId,
  }));

  const topVendorsByOrders = orderAgg.map((v) => ({
    vendorId: v.vendorId,
    storeName: vendorNameMap.get(v.vendorId) ?? "Unknown",
    totalOrders: v._count.orderId,
    totalRevenue: v._sum.totalAmount ?? 0,
  }));

  // Vendors with no orders in range
  const vendorsWithOrdersInRange = await prisma.order.findMany({
    where: {
      status: { in: PAID_STATUSES },
      createdAt: { gte: since },
      vendorId: { not: null },
    },
    select: { vendorId: true },
    distinct: ["vendorId"],
  });
  const totalVendors = await prisma.vendor.count();
  const vendorsWithNoOrders = totalVendors - vendorsWithOrdersInRange.length;

  // Vendor locations
  const vendorLocs = await prisma.vendor.groupBy({
    by: ["country", "city"],
    where: { country: { not: null } },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 20,
  });
  const vendorLocations = vendorLocs
    .filter((v) => v.country)
    .map((v) => ({ country: v.country!, city: v.city, count: v._count.id }));

  // Vendor retention: active in both current and previous period
  const currentVendorIds = new Set(vendorsWithOrdersInRange.map((v) => v.vendorId));
  const previousPeriodVendors = await prisma.order.findMany({
    where: {
      status: { in: PAID_STATUSES },
      vendorId: { not: null },
      createdAt: { gte: previousSince, lt: since },
    },
    select: { vendorId: true },
    distinct: ["vendorId"],
  });
  const previousIds = previousPeriodVendors.map((v) => v.vendorId!);
  const retained = previousIds.filter((id) => currentVendorIds.has(id)).length;
  const vendorRetentionRate = previousIds.length > 0
    ? Math.round((retained / previousIds.length) * 10000) / 100
    : 0;

  return {
    topVendorsByRevenue,
    topVendorsByOrders,
    vendorsWithNoOrders,
    vendorLocations,
    vendorRetentionRate,
    totalVendors,
    currency: env.defaultCurrency,
  };
}

// ─── ORDER ANALYTICS ────────────────────────────────────────────────────────

export interface OrderAnalytics {
  ordersByDay: { date: string; count: number; gmv: number }[];
  ordersByWeek: { week: string; count: number; gmv: number }[];
  ordersByMonth: { month: string; count: number; gmv: number }[];
  avgOrderValue: number;
  topProducts: {
    productId: string;
    title: string;
    totalQuantity: number;
    totalRevenue: number;
  }[];
  topCategories: {
    category: string;
    totalQuantity: number;
    totalRevenue: number;
  }[];
  currency: string;
}

export async function getOrderAnalytics(rawRange: unknown): Promise<OrderAnalytics> {
  const { days } = parseRange(rawRange);
  const since = sinceDate(days);

  // Fetch paid orders in range
  const orders = await prisma.order.findMany({
    where: { status: { in: PAID_STATUSES }, createdAt: { gte: since } },
    select: { totalAmount: true, createdAt: true },
  });

  // Group by day
  const byDay = new Map<string, { count: number; gmv: number }>();
  const byWeek = new Map<string, { count: number; gmv: number }>();
  const byMonth = new Map<string, { count: number; gmv: number }>();

  for (const o of orders) {
    const dk = dayKey(o.createdAt);
    const wk = weekKey(o.createdAt);
    const mk = monthKey(o.createdAt);

    const d = byDay.get(dk) ?? { count: 0, gmv: 0 };
    d.count++;
    d.gmv += o.totalAmount;
    byDay.set(dk, d);

    const w = byWeek.get(wk) ?? { count: 0, gmv: 0 };
    w.count++;
    w.gmv += o.totalAmount;
    byWeek.set(wk, w);

    const m = byMonth.get(mk) ?? { count: 0, gmv: 0 };
    m.count++;
    m.gmv += o.totalAmount;
    byMonth.set(mk, m);
  }

  const ordersByDay = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  const ordersByWeek = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, v]) => ({ week, ...v }));

  const ordersByMonth = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, ...v }));

  // AVG order value
  const totalGmv = orders.reduce((s, o) => s + o.totalAmount, 0);
  const avgOrderValue = orders.length > 0 ? Math.round(totalGmv / orders.length) : 0;

  // Top products by quantity sold
  const productAgg = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: { order: { status: { in: PAID_STATUSES }, createdAt: { gte: since } } },
    _sum: { quantity: true, totalAmount: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 10,
  });

  const productIds = productAgg.map((p) => p.productId);
  const products = productIds.length > 0
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, title: true, category: true },
      })
    : [];
  const productMap = new Map(products.map((p) => [p.id, p]));

  const topProducts = productAgg.map((p) => ({
    productId: p.productId,
    title: productMap.get(p.productId)?.title ?? "Unknown",
    totalQuantity: p._sum.quantity ?? 0,
    totalRevenue: p._sum.totalAmount ?? 0,
  }));

  // Top categories by revenue
  // Need to join OrderItem → Product for category
  const itemsWithProducts = await prisma.orderItem.findMany({
    where: { order: { status: { in: PAID_STATUSES }, createdAt: { gte: since } } },
    select: {
      quantity: true,
      totalAmount: true,
      product: { select: { category: true } },
    },
  });

  const catMap = new Map<string, { totalQuantity: number; totalRevenue: number }>();
  for (const item of itemsWithProducts) {
    const cat = item.product?.category || "Uncategorized";
    const entry = catMap.get(cat) ?? { totalQuantity: 0, totalRevenue: 0 };
    entry.totalQuantity += item.quantity;
    entry.totalRevenue += item.totalAmount;
    catMap.set(cat, entry);
  }

  const topCategories = [...catMap.entries()]
    .sort((a, b) => b[1].totalRevenue - a[1].totalRevenue)
    .slice(0, 10)
    .map(([category, v]) => ({ category, ...v }));

  return {
    ordersByDay,
    ordersByWeek,
    ordersByMonth,
    avgOrderValue,
    topProducts,
    topCategories,
    currency: env.defaultCurrency,
  };
}
