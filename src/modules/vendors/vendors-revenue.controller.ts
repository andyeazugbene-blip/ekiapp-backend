import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const VALID_RANGES = new Set(["7d", "30d", "90d"]);
const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

const PAID_STATUSES = ["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED"] as const;

function parseRange(raw: unknown): { range: "7d" | "30d" | "90d"; days: number } {
  if (raw === undefined) {
    return { range: "30d", days: RANGE_DAYS["30d"] };
  }
  if (typeof raw !== "string" || !VALID_RANGES.has(raw)) {
    throw new AppError("range must be 7d, 30d, or 90d", 400);
  }
  return { range: raw as "7d" | "30d" | "90d", days: RANGE_DAYS[raw] };
}

function dayKey(date: Date): string {
  // YYYY-MM-DD in UTC for stable bucketing
  return date.toISOString().slice(0, 10);
}

function buildEmptySeries(days: number): { date: string; revenue: number; orders: number }[] {
  const out: { date: string; revenue: number; orders: number }[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push({ date: dayKey(d), revenue: 0, orders: 0 });
  }
  return out;
}

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

/**
 * GET /api/vendors/me/revenue?range=7d|30d|90d
 *
 * Returns revenue summary + daily series for the authenticated vendor.
 * Currency uses the vendor.currency. Empty period returns a zeroed series
 * (one entry per day in the range), never crashes.
 */
export async function getVendorRevenue(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, currency: true },
  });
  if (!vendor) throw new AppError("Vendor profile required", 403);

  const { range, days } = parseRange(request.query.range);
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  // Wallet balances (available + pending)
  const wallet = await prisma.wallet.findUnique({
    where: { vendorId: vendor.id },
    select: { pendingBalance: true, availableBalance: true, currency: true },
  });

  // Pull all paid orderItems in window, grouped by day. We sum totalAmount
  // per orderItem (vendor's gross). The buyer-side delivery fee is excluded
  // because it does not belong to vendor revenue.
  const items = await prisma.orderItem.findMany({
    where: {
      vendorId: vendor.id,
      order: {
        status: { in: PAID_STATUSES as unknown as string[] } as never,
        createdAt: { gte: since },
      },
    },
    select: {
      totalAmount: true,
      orderId: true,
      order: { select: { createdAt: true } },
    },
  });

  const byDay = new Map<string, { revenue: number; orderIds: Set<string> }>();
  for (const it of items) {
    const key = dayKey(it.order.createdAt);
    const bucket = byDay.get(key) ?? { revenue: 0, orderIds: new Set<string>() };
    bucket.revenue += it.totalAmount;
    bucket.orderIds.add(it.orderId);
    byDay.set(key, bucket);
  }

  const series = buildEmptySeries(days).map((row) => {
    const bucket = byDay.get(row.date);
    return {
      date: row.date,
      revenue: bucket?.revenue ?? 0,
      orders: bucket?.orderIds.size ?? 0,
    };
  });

  const totalRevenue = series.reduce((sum, r) => sum + r.revenue, 0);
  const totalOrderIds = new Set<string>();
  for (const it of items) totalOrderIds.add(it.orderId);
  const orderCount = totalOrderIds.size;
  const averageOrderValue = orderCount > 0 ? Math.round(totalRevenue / orderCount) : 0;

  response.status(200).json({
    range,
    currency: wallet?.currency ?? vendor.currency.toLowerCase(),
    totalRevenue,
    pendingBalance: wallet?.pendingBalance ?? 0,
    availableBalance: wallet?.availableBalance ?? 0,
    orderCount,
    averageOrderValue,
    series,
  });
}
