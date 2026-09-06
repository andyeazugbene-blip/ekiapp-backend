import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { subscriptionsService } from "../subscriptions/subscriptions.service";
import { marketConfigurationService } from "../community-buy/market-configuration.service";
import { vendorMarketsService } from "./vendor-markets.service";
import type { DashboardAlert, DashboardToolEntry, RecommendedAction, VendorDashboardData, VendorEarningsData } from "./vendors-dashboard.types";

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
      select: { id: true, storeName: true, country: true, verificationStatus: true },
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

    // Hide unavailable features (spec rule) — a zero-count urgent action is
    // "unavailable" (nothing to act on), so it's dropped, not shown as 0.
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
    // Maximum three urgent actions (spec rule) — defensive cap; today there
    // are only 3 possible alert types, so this never actually truncates.
    const urgentActions = alerts.slice(0, 3);

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

    const totalOrdersRows = await prisma.orderItem.findMany({
      where: { vendorId: vendor.id, order: { status: { notIn: ["PENDING", "FAILED"] } } },
      select: { orderId: true },
      distinct: ["orderId"],
    });
    const totalOrders = totalOrdersRows.length;

    const totalProducts = await prisma.product.count({
      where: { vendorId: vendor.id, isActive: true },
    });

    // ─── New architecture-mandated groups (doc "Module 3 — Dashboard
    // Orchestration" / screen 01) — additive alongside the legacy fields
    // above, which the shipped mobile client still reads unchanged. ───────

    const [ratingAgg, buyerOrderCounts, bundleCount, flashSaleCount, marketAssignments, account] = await Promise.all([
      prisma.review.aggregate({ where: { vendorId: vendor.id, status: "APPROVED" }, _avg: { rating: true }, _count: { _all: true } }),
      prisma.order.groupBy({
        by: ["buyerId"],
        where: { vendorId: vendor.id, status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } },
        _count: { _all: true },
      }),
      prisma.bundle.count({ where: { vendorId: vendor.id } }),
      prisma.flashSale.count({ where: { vendorId: vendor.id } }),
      vendorMarketsService.listForVendor(vendor.id),
      subscriptionsService.getVendorAccount(userId),
    ]);

    // A multi-market vendor sees a marketing tool if ANY of their active
    // markets has it enabled — not just whichever market happens to be
    // primary. Falls back to vendor.country directly for a vendor with no
    // assignment rows yet (pre-backfill edge case).
    const activeAssignments = marketAssignments.filter((m) => m.enabled);
    const marketConfigs = activeAssignments.length > 0
      ? await Promise.all(activeAssignments.map((m) => marketConfigurationService.get(m.marketCode)))
      : vendor.country
        ? [await marketConfigurationService.get(vendor.country)]
        : [];
    const anyMarketHas = (flag: "regularDeliveriesEnabled" | "communityBuyEnabled"): boolean =>
      marketConfigs.some((config) => config?.[flag] === true);

    const buyersCount = buyerOrderCounts.length;
    const repeatBuyers = buyerOrderCounts.filter((b) => b._count._all >= 2).length;
    const isVerified = vendor.verificationStatus === "VERIFIED";

    // Exactly one recommendation, and never one that repeats what an
    // urgent action already surfaced (spec rule) — each branch here covers
    // ground no urgent_action type does (verification / onboarding / an
    // unused feature), so there's no overlap to filter out after the fact.
    let recommendedAction: RecommendedAction | null = null;
    if (!isVerified) {
      recommendedAction = { id: "verify_account", type: "verify_account", label: "Complete verification to accept orders", reason: "Your store can't take orders until identity verification is approved." };
    } else if (totalProducts === 0) {
      recommendedAction = { id: "add_product", type: "add_product", label: "Add your first foodstuff", reason: "Your store has no listed products yet." };
    } else if (account.limits.bundles && bundleCount === 0 && flashSaleCount === 0) {
      recommendedAction = { id: "try_marketing_tools", type: "try_marketing_tools", label: "Try a Bundle or Flash Sale to boost sales", reason: "You haven't used any marketing tools yet." };
    }

    const marketingTools: DashboardToolEntry[] = [];
    if (account.limits.bundles) {
      marketingTools.push({ id: "bundles", type: "bundles", label: "Bundles", route: "/(vendor)/create-bundle" });
    }
    if (account.limits.flashSales) {
      marketingTools.push({ id: "flash_sales", type: "flash_sales", label: "Flash Sales", route: "/(vendor)/create-flash-sale" });
    }
    // Market-aware visibility (spec rule: "do not show Community Buy in
    // unsupported markets") — real backend market config, not a client guess.
    if (anyMarketHas("regularDeliveriesEnabled")) {
      marketingTools.push({ id: "regular_deliveries", type: "regular_deliveries", label: "Regular Deliveries", route: "/(vendor)/regular-deliveries" });
    }
    if (anyMarketHas("communityBuyEnabled")) {
      marketingTools.push({ id: "community_buy", type: "community_buy", label: "Community Buy", route: "/(vendor)/community-buy-supplier" });
    }

    const businessTools: DashboardToolEntry[] = [
      { id: "orders", type: "orders", label: "Orders", route: "/(vendor)/orders", count: totalOrders },
      { id: "foodstuff", type: "foodstuff", label: "Foodstuff", route: "/(vendor)/foodstuff", count: totalProducts },
      { id: "buyers", type: "buyers", label: "Buyers", route: "/(vendor)/buyers", count: buyersCount },
      { id: "messages", type: "messages", label: "Messages", route: "/(vendor)/messages", count: unreadMessages },
    ];

    return {
      greeting: "Welcome back,",
      storeName: vendor.storeName,
      alerts,
      earnings: {
        salesToday,
        salesThisWeek,
        salesThisMonth,
        pendingPayout: wallet?.pendingBalance ?? 0,
        availableBalance: wallet?.availableBalance ?? 0,
        currency: wallet?.currency ?? "usd",
      },
      insights: {
        bestSellingProduct: bestSelling[0]?.productTitle ?? null,
        totalOrders,
        totalProducts,
      },

      header: { greeting: "Welcome back,", storeName: vendor.storeName, verified: isVerified },
      urgent_actions: urgentActions,
      recommended_action: recommendedAction,
      business_overview: {
        salesToday,
        salesThisWeek,
        salesThisMonth,
        currency: wallet?.currency ?? "usd",
        pendingPayout: wallet?.pendingBalance ?? 0,
        availableBalance: wallet?.availableBalance ?? 0,
        bestSellingProduct: bestSelling[0]?.productTitle ?? null,
        totalOrders,
        totalProducts,
      },
      marketing_tools: marketingTools,
      business_tools: businessTools,
      business_counts: {
        products: totalProducts,
        orders: totalOrders,
        buyers: buyersCount,
        lowStock: lowStockProducts,
      },
      performance: {
        rating: ratingAgg._avg.rating ?? 0,
        totalReviews: ratingAgg._count._all,
        repeatBuyers,
      },
      vendor_account_status: {
        verificationStatus: account.verificationStatus,
        accountStatus: account.accountStatus,
        serviceLevel: account.serviceLevel,
        serviceName: account.serviceName,
        ordersRemaining: account.limits.ordersRemaining,
        maxOrders: account.limits.maxOrders,
        renewalDate: account.renewalDate,
      },
      markets: marketAssignments.map((m) => ({
        marketCode: m.marketCode,
        countryName: m.countryName,
        currency: m.currency,
        enabled: m.enabled,
        isPrimary: m.countryName.trim().toLowerCase() === (vendor.country ?? "").trim().toLowerCase(),
      })),
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
