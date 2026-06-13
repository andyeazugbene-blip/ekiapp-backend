import type { Request, Response } from "express";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const VALID_RANGES = new Set(["7d", "30d", "90d"]);
const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

function parseRange(raw: unknown): { range: "7d" | "30d" | "90d"; days: number } {
  const value = typeof raw === "string" && VALID_RANGES.has(raw) ? raw : "30d";
  return { range: value as "7d" | "30d" | "90d", days: RANGE_DAYS[value] };
}

function dayKey(date: Date): string {
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

export async function getAdminRevenue(request: Request, response: Response): Promise<void> {
  if (request.query.range !== undefined && typeof request.query.range === "string" && !VALID_RANGES.has(request.query.range)) {
    throw new AppError("range must be 7d, 30d, or 90d", 400);
  }
  const { range, days } = parseRange(request.query.range);
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const stripePayments = await prisma.payment.findMany({
    where: { status: "SUCCEEDED", provider: "stripe", processedAt: { gte: since } },
    select: { amount: true, processedAt: true, orderId: true },
  });
  const paystackTxs = await prisma.paystackTransaction.findMany({
    where: { status: "SUCCESS", updatedAt: { gte: since } },
    select: { amount: true, updatedAt: true, orderId: true },
  });

  type DayBucket = { date: string; stripeRevenue: number; paystackRevenue: number; revenue: number; orderIds: Set<string> };
  const byDay = new Map<string, DayBucket>();
  function bucket(date: string): DayBucket {
    const existing = byDay.get(date);
    if (existing) return existing;
    const fresh: DayBucket = { date, stripeRevenue: 0, paystackRevenue: 0, revenue: 0, orderIds: new Set() };
    byDay.set(date, fresh);
    return fresh;
  }
  for (const p of stripePayments) {
    if (!p.processedAt) continue;
    const b = bucket(dayKey(p.processedAt));
    b.stripeRevenue += p.amount; b.revenue += p.amount; b.orderIds.add(p.orderId);
  }
  for (const t of paystackTxs) {
    const b = bucket(dayKey(t.updatedAt));
    b.paystackRevenue += t.amount; b.revenue += t.amount; b.orderIds.add(t.orderId);
  }

  const series = buildEmptySeries(days).map((row) => {
    const b = byDay.get(row.date);
    return { date: row.date, revenue: b?.revenue ?? 0, stripeRevenue: b?.stripeRevenue ?? 0, paystackRevenue: b?.paystackRevenue ?? 0, orders: b?.orderIds.size ?? 0 };
  });

  const totalRevenue = series.reduce((s, r) => s + r.revenue, 0);
  const totalStripe = series.reduce((s, r) => s + r.stripeRevenue, 0);
  const totalPaystack = series.reduce((s, r) => s + r.paystackRevenue, 0);
  const orderIds = new Set<string>();
  for (const b of byDay.values()) { for (const id of b.orderIds) orderIds.add(id); }
  const orderCount = orderIds.size;
  const averageOrderValue = orderCount > 0 ? Math.round(totalRevenue / orderCount) : 0;

  // Platform net calculations
  const feeAgg = await prisma.payment.aggregate({ where: { status: "SUCCEEDED", processedAt: { gte: since } }, _sum: { platformFeeAmount: true, vendorEarningsAmount: true } });
  const totalPlatformFees = feeAgg._sum.platformFeeAmount ?? 0;
  const totalVendorEarnings = feeAgg._sum.vendorEarningsAmount ?? 0;
  const payoutAgg = await prisma.payoutRequest.aggregate({ where: { status: "PAID", paidAt: { gte: since } }, _sum: { amount: true } });
  const totalPayouts = payoutAgg._sum.amount ?? 0;
  const netRevenue = totalPlatformFees - totalPayouts;

  response.status(200).json({
    range, currency: env.defaultCurrency,
    grossRevenue: totalRevenue, platformFees: totalPlatformFees,
    vendorEarnings: totalVendorEarnings, totalPayouts, netRevenue,
    stripeRevenue: totalStripe, paystackRevenue: totalPaystack,
    orderCount, averageOrderValue, series,
  });
}