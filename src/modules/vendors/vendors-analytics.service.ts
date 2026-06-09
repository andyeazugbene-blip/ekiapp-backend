import { OrderStatus, type Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { publicStoresService } from "../public-stores/public-stores.service";
import type {
  VendorAnalyticsData,
  VendorAnalyticsInsight,
  VendorAnalyticsRange,
  VendorAnalyticsTopProduct,
} from "./vendors-analytics.types";

const PAID_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.PAYMENT_SECURED,
  OrderStatus.CONFIRMED,
  OrderStatus.VENDOR_CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.DISPATCHED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.AUTO_RELEASED,
];

const COMPLETED_STATUSES = new Set<OrderStatus>([
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.AUTO_RELEASED,
]);

function centsToUnit(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value / 100 : 0;
}

function parseRange(raw: unknown): VendorAnalyticsRange {
  if (raw === "today" || raw === "7d" || raw === "month" || raw === "30d" || raw === "all") {
    return raw;
  }
  return "month";
}

function rangeStart(range: VendorAnalyticsRange): Date | undefined {
  const now = new Date();
  if (range === "all") return undefined;
  if (range === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (range === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const days = range === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

async function getVendor(userId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, storeSlug: true, currency: true },
  });
  if (!vendor) throw new AppError("Vendor profile required", 403);
  return vendor;
}

function buildTopProducts(
  items: {
    productId: string;
    productTitle: string;
    quantity: number;
    totalAmount: number;
    costAmount?: number | null;
    orderId: string;
    product?: { costAmount?: number | null } | null;
  }[],
): VendorAnalyticsTopProduct[] {
  const productMap = new Map<string, VendorAnalyticsTopProduct & { orderIds: Set<string> }>();

  for (const item of items) {
    const current = productMap.get(item.productId) ?? {
      productId: item.productId,
      name: item.productTitle,
      orders: 0,
      orderIds: new Set<string>(),
      unitsSold: 0,
      revenue: 0,
      estimatedProfit: undefined,
      hasCost: false,
    };

    current.orderIds.add(item.orderId);
    current.orders = current.orderIds.size;
    current.unitsSold += item.quantity;
    current.revenue += centsToUnit(item.totalAmount);
    const unitCost = item.costAmount ?? item.product?.costAmount ?? null;
    if (typeof unitCost === "number" && unitCost > 0) {
      current.hasCost = true;
      current.estimatedProfit = (current.estimatedProfit ?? 0) + centsToUnit(item.totalAmount - unitCost * item.quantity);
    }
    productMap.set(item.productId, current);
  }

  return [...productMap.values()]
    .map(({ orderIds: _orderIds, ...product }) => product)
    .sort((left, right) => right.revenue - left.revenue || right.unitsSold - left.unitsSold)
    .slice(0, 5);
}

function buildInsights(input: {
  storeVisits: number;
  checkoutStarted: number;
  ordersCompleted: number;
  inactiveBuyers30d: number;
  lowStockProduct?: { id: string; title: string; stock: number } | null;
  hasBuyers: boolean;
}): VendorAnalyticsInsight[] {
  const insights: VendorAnalyticsInsight[] = [];

  if (input.storeVisits === 0) {
    insights.push({
      id: "share-store",
      title: "Get first store visits",
      body: "Share your store link so buyers can browse, add to cart, and order from your public storefront.",
      action: "share_store",
      actionLabel: "Share store",
      severity: "info",
    });
  }

  if (input.inactiveBuyers30d > 0) {
    insights.push({
      id: "inactive-buyers",
      title: "Bring buyers back",
      body: `${input.inactiveBuyers30d} buyers have not ordered in 30 days.`,
      action: "send_offer",
      actionLabel: "Send offer",
      severity: "warning",
    });
  }

  if (input.lowStockProduct) {
    insights.push({
      id: `restock-${input.lowStockProduct.id}`,
      title: "Restock a product",
      body: `${input.lowStockProduct.title} has ${input.lowStockProduct.stock} left.`,
      action: "restock_product",
      actionLabel: "Restock product",
      productId: input.lowStockProduct.id,
      severity: "warning",
    });
  }

  if (input.checkoutStarted > input.ordersCompleted) {
    insights.push({
      id: "recover-checkouts",
      title: "Recover checkout intent",
      body: "Some buyers started checkout but did not finish the order.",
      action: "send_reminder",
      actionLabel: "Send reminder",
      severity: "info",
    });
  }

  if (input.hasBuyers) {
    insights.push({
      id: "review-buyers",
      title: "Review buyer activity",
      body: "See repeat buyers and last order dates before sending offers.",
      action: "view_buyers",
      actionLabel: "View buyers",
      severity: "success",
    });
  }

  return insights.slice(0, 4);
}

export const vendorAnalyticsService = {
  async getAnalytics(userId: string, rawRange: unknown): Promise<VendorAnalyticsData> {
    const range = parseRange(rawRange);
    const since = rangeStart(range);
    const vendor = await getVendor(userId);

    const orderWhere: Prisma.OrderWhereInput = {
      vendorId: vendor.id,
      status: { in: PAID_STATUSES },
      ...(since ? { createdAt: { gte: since } } : {}),
    };

    const [
      wallet,
      orders,
      allVendorOrders,
      orderItems,
      publicAnalytics,
      lowStockProduct,
    ] = await Promise.all([
      prisma.wallet.findUnique({
        where: { vendorId: vendor.id },
        select: { pendingBalance: true, availableBalance: true, currency: true },
      }),
      prisma.order.findMany({
        where: orderWhere,
        select: {
          id: true,
          buyerId: true,
          status: true,
          totalAmount: true,
          vendorEarnings: true,
          subtotalAmount: true,
          deliveryFeeAmount: true,
          platformFeeAmount: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.order.findMany({
        where: {
          vendorId: vendor.id,
          status: { in: PAID_STATUSES },
        },
        select: {
          buyerId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.orderItem.findMany({
        where: {
          vendorId: vendor.id,
          order: orderWhere,
        },
        select: {
          productId: true,
          productTitle: true,
          quantity: true,
          totalAmount: true,
          costAmount: true,
          costCurrency: true,
          orderId: true,
          product: { select: { costAmount: true, costCurrency: true } },
        },
      }),
      publicStoresService.getDetailedAnalyticsForUser(userId).catch(() => null),
      prisma.product.findFirst({
        where: { vendorId: vendor.id, isActive: true, stock: { gt: 0, lte: 5 } },
        select: { id: true, title: true, stock: true },
        orderBy: { stock: "asc" },
      }),
    ]);

    const totalRevenue = orderItems.reduce((sum, item) => sum + item.totalAmount, 0);
    const vendorEarnings = orders.reduce((sum, order) => sum + order.vendorEarnings, 0);
    const missingCostItems = orderItems.filter((item) => {
      const unitCost = item.costAmount ?? item.product?.costAmount ?? null;
      return !(typeof unitCost === "number" && unitCost > 0);
    });
    const hasCompleteCostData = orderItems.length > 0 && missingCostItems.length === 0;
    const totalProductCost = orderItems.reduce((sum, item) => {
      const unitCost = item.costAmount ?? item.product?.costAmount ?? null;
      return typeof unitCost === "number" && unitCost > 0 ? sum + unitCost * item.quantity : sum;
    }, 0);
    const totalDeliveryCost = orders.reduce((sum, order) => sum + order.deliveryFeeAmount, 0);
    const totalPlatformFees = orders.reduce((sum, order) => sum + order.platformFeeAmount, 0);
    const estimatedProfit = hasCompleteCostData
      ? totalRevenue - totalProductCost - totalDeliveryCost - totalPlatformFees
      : vendorEarnings - totalProductCost - totalDeliveryCost;
    const completedOrders = orders.filter((order) => COMPLETED_STATUSES.has(order.status)).length;
    const orderBuyerIds = new Map<string, { count: number; lastOrderAt: Date }>();
    const rangeBuyerIds = new Set(orders.map((order) => order.buyerId));

    for (const order of allVendorOrders) {
      const current = orderBuyerIds.get(order.buyerId) ?? { count: 0, lastOrderAt: order.createdAt };
      current.count += 1;
      if (order.createdAt > current.lastOrderAt) current.lastOrderAt = order.createdAt;
      orderBuyerIds.set(order.buyerId, current);
    }

    const inactiveCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const repeatBuyers = [...orderBuyerIds.values()].filter((buyer) => buyer.count > 1).length;
    const inactiveBuyers30d = [...orderBuyerIds.values()].filter((buyer) => buyer.lastOrderAt < inactiveCutoff).length;

    const firstOrders = await prisma.order.groupBy({
      by: ["buyerId"],
      where: { vendorId: vendor.id, status: { in: PAID_STATUSES } },
      _min: { createdAt: true },
    });
    const newBuyers = firstOrders.filter((row) => {
      if (!since) return true;
      const firstOrderAt = row._min?.createdAt;
      return firstOrderAt ? firstOrderAt >= since : false;
    }).length;

    const storeVisits = publicAnalytics?.opens ?? 0;
    const checkoutStarted = publicAnalytics?.checkoutStarts ?? 0;
    const publicCompleted = publicAnalytics?.completedOrders || publicAnalytics?.ordersPlaced || 0;
    const ordersCompleted = publicCompleted || completedOrders;
    const conversionRate = storeVisits > 0 ? (ordersCompleted / storeVisits) * 100 : 0;

    return {
      range,
      summary: {
        currency: (wallet?.currency ?? vendor.currency ?? "EUR").toUpperCase(),
        totalRevenue: centsToUnit(totalRevenue),
        estimatedProfit: centsToUnit(estimatedProfit),
        estimatedProfitAvailable: hasCompleteCostData,
        availableForPayout: centsToUnit(wallet?.availableBalance),
        pendingBalance: centsToUnit(wallet?.pendingBalance),
      },
      salesFunnel: {
        storeVisits,
        checkoutStarted,
        ordersCompleted,
        conversionRate: publicAnalytics?.conversionRate ?? conversionRate,
        repeatOrders: publicAnalytics?.reorders ?? Math.max(0, orders.length - rangeBuyerIds.size),
        storeSaves: publicAnalytics?.saveVendorCount ?? 0,
      },
      customerInsights: {
        newBuyers,
        repeatBuyers,
        inactiveBuyers30d,
      },
      topProducts: buildTopProducts(orderItems),
      insights: buildInsights({
        storeVisits,
        checkoutStarted,
        ordersCompleted,
        inactiveBuyers30d,
        lowStockProduct,
        hasBuyers: orderBuyerIds.size > 0,
      }),
    };
  },
};
