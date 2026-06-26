import { OrderStatus, WalletTransactionType } from "@prisma/client";

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

function parseRange(raw: unknown): { range: Range; days: number } {
  const value = typeof raw === "string" && raw in VALID_RANGES ? raw : "30d";
  return { range: value as Range, days: VALID_RANGES[value as Range] };
}

// ─── PAYMENT ANALYTICS ────────────────────────────────────────────────────────

export interface PaymentAnalyticsResult {
  successfulPayments: { count: number; amount: number };
  failedPayments: { count: number; amount: number };
  refunds: { count: number; amount: number };
  escrow: {
    pendingCredits: { count: number; amount: number };
    releases: { count: number; amount: number };
    payoutDebits: { count: number; amount: number };
    adjustments: { count: number; amount: number };
  };
  payouts: {
    totalPaid: { count: number; amount: number };
    totalPending: { count: number; amount: number };
    recentPayouts: {
      id: string;
      vendorId: string;
      storeName: string;
      amount: number;
      netAmount: number;
      status: string;
      paidAt: string | null;
      createdAt: string;
    }[];
  };
  currency: string;
}

export async function getPaymentAnalytics(rawRange: unknown): Promise<PaymentAnalyticsResult> {
  const { days } = parseRange(rawRange);
  const since = sinceDate(days);

  const [successAgg, failedAgg, refundAgg, walletAgg, paidPayoutAgg, pendingPayoutAgg, recentPayouts] =
    await Promise.all([
      prisma.payment.aggregate({
        where: { status: "SUCCEEDED", createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { status: "FAILED", createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.order.aggregate({
        where: { status: "REFUNDED", updatedAt: { gte: since } },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.walletTransaction.groupBy({
        by: ["type"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.payoutRequest.aggregate({
        where: { status: "PAID", createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.payoutRequest.aggregate({
        where: { status: "PENDING" },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.payoutRequest.findMany({
        where: { status: "PAID" },
        orderBy: { paidAt: "desc" },
        take: 10,
        include: { vendor: { select: { id: true, storeName: true } } },
      }),
    ]);

  const walletByType = new Map(
    walletAgg.map((w) => [w.type, { count: w._count._all, amount: w._sum.amount ?? 0 }]),
  );
  const getWT = (t: WalletTransactionType) => walletByType.get(t) ?? { count: 0, amount: 0 };

  const adjCredit = getWT("ADJUSTMENT_CREDIT");
  const adjDebit = getWT("ADJUSTMENT_DEBIT");

  return {
    successfulPayments: {
      count: successAgg._count._all,
      amount: successAgg._sum.amount ?? 0,
    },
    failedPayments: {
      count: failedAgg._count._all,
      amount: failedAgg._sum.amount ?? 0,
    },
    refunds: {
      count: refundAgg._count._all,
      amount: refundAgg._sum.totalAmount ?? 0,
    },
    escrow: {
      pendingCredits: getWT("PAYMENT_PENDING_CREDIT"),
      releases: getWT("PENDING_TO_AVAILABLE"),
      payoutDebits: getWT("PAYOUT_DEBIT"),
      adjustments: {
        count: adjCredit.count + adjDebit.count,
        amount: adjCredit.amount - adjDebit.amount,
      },
    },
    payouts: {
      totalPaid: {
        count: paidPayoutAgg._count._all,
        amount: paidPayoutAgg._sum.amount ?? 0,
      },
      totalPending: {
        count: pendingPayoutAgg._count._all,
        amount: pendingPayoutAgg._sum.amount ?? 0,
      },
      recentPayouts: recentPayouts.map((p) => ({
        id: p.id,
        vendorId: p.vendorId,
        storeName: p.vendor.storeName,
        amount: p.amount,
        netAmount: p.netAmount ?? p.amount,
        status: p.status,
        paidAt: p.paidAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      })),
    },
    currency: env.defaultCurrency,
  };
}

// ─── GEOGRAPHIC ANALYTICS ──────────────────────────────────────────────────────

export interface GeographicAnalyticsResult {
  ordersByCountry: { country: string; count: number; gmv: number }[];
  ordersByCity: { city: string; country: string; count: number; gmv: number }[];
  buyerLocations: { country: string; city: string | null; count: number }[];
  vendorLocations: { country: string; city: string | null; count: number }[];
  currency: string;
}

export async function getGeographicAnalytics(rawRange: unknown): Promise<GeographicAnalyticsResult> {
  const { days } = parseRange(rawRange);
  const since = sinceDate(days);

  // Paid orders in range
  const paidOrders = await prisma.order.findMany({
    where: { status: { in: PAID_STATUSES }, createdAt: { gte: since } },
    select: { buyerId: true, totalAmount: true },
  });

  // Buyer addresses (prefer default) for geographic mapping
  const buyerIds = [...new Set(paidOrders.map((o) => o.buyerId))];
  const buyerAddresses =
    buyerIds.length > 0
      ? await prisma.buyerAddress.findMany({
          where: { buyerId: { in: buyerIds } },
          select: { buyerId: true, country: true, city: true, isDefault: true },
          orderBy: { isDefault: "desc" },
        })
      : [];

  // One address per buyer (default first)
  const buyerAddrMap = new Map<string, { country: string; city: string }>();
  for (const addr of buyerAddresses) {
    if (!buyerAddrMap.has(addr.buyerId)) {
      buyerAddrMap.set(addr.buyerId, { country: addr.country, city: addr.city });
    }
  }

  // Aggregate orders by country + city
  const countryAgg = new Map<string, { count: number; gmv: number }>();
  const cityAgg = new Map<string, { country: string; count: number; gmv: number }>();

  for (const order of paidOrders) {
    const addr = buyerAddrMap.get(order.buyerId);
    if (!addr) continue;

    const cEntry = countryAgg.get(addr.country) ?? { count: 0, gmv: 0 };
    cEntry.count++;
    cEntry.gmv += order.totalAmount;
    countryAgg.set(addr.country, cEntry);

    if (addr.city) {
      const cityKey = `${addr.city}|${addr.country}`;
      const ctEntry = cityAgg.get(cityKey) ?? { country: addr.country, count: 0, gmv: 0 };
      ctEntry.count++;
      ctEntry.gmv += order.totalAmount;
      cityAgg.set(cityKey, ctEntry);
    }
  }

  const ordersByCountry = [...countryAgg.entries()]
    .sort((a, b) => b[1].gmv - a[1].gmv)
    .slice(0, 20)
    .map(([country, v]) => ({ country, ...v }));

  const ordersByCity = [...cityAgg.entries()]
    .sort((a, b) => b[1].gmv - a[1].gmv)
    .slice(0, 20)
    .map(([key, v]) => ({ city: key.split("|")[0], country: v.country, count: v.count, gmv: v.gmv }));

  // Buyer locations from BuyerAddress (default only = 1 per buyer)
  const defaultBuyerAddrs = await prisma.buyerAddress.findMany({
    where: { isDefault: true },
    select: { country: true, city: true },
  });

  const buyerLocMap = new Map<string, number>();
  for (const addr of defaultBuyerAddrs) {
    const key = `${addr.country}|${addr.city}`;
    buyerLocMap.set(key, (buyerLocMap.get(key) ?? 0) + 1);
  }

  const buyerLocations = [...buyerLocMap.entries()]
    .map(([key, count]) => {
      const [country, city] = key.split("|");
      return { country, city: city || null, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // Vendor locations
  const vendorLocs = await prisma.vendor.groupBy({
    by: ["country", "city"],
    where: { country: { not: null } },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 30,
  });

  const vendorLocations = vendorLocs
    .filter((v) => v.country)
    .map((v) => ({ country: v.country!, city: v.city, count: v._count.id }));

  return {
    ordersByCountry,
    ordersByCity,
    buyerLocations,
    vendorLocations,
    currency: env.defaultCurrency,
  };
}
