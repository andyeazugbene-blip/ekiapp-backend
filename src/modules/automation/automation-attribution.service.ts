import { prisma } from "../../lib/prisma";
import { launchSettingsService } from "../admin/launch-settings.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_DAYS = 30;
const MAX_RUNS = 5000;
const PAID_STATUSES = ["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED", "AUTO_RELEASED", "PAYMENT_SECURED", "VENDOR_CONFIRMED"] as const;

type Run = { type: string; vendorId: string | null; recipientUserId: string; sentAt: Date };
type Order = {
  id: string;
  buyerId: string;
  createdAt: Date;
  totalAmount: number;
  currency: string;
  items: { vendorId: string; totalAmount: number }[];
  refunds: { amountMinor: number }[];
};

export type AttributedOrder = { type: string; currency: string; gross: number; refunds: number };

/**
 * Handbook 12.1 "automation-assisted": the buyer was exposed to an automation
 * before the order, within the window. Each order counts once, for the most
 * recent automation that reached the buyer. A vendor's automation only counts
 * that vendor's items, because one order can span vendors.
 */
export function attributeOrders(runs: Run[], orders: Order[], windowMs: number): AttributedOrder[] {
  const runsByBuyer = new Map<string, Run[]>();
  for (const run of runs) {
    const list = runsByBuyer.get(run.recipientUserId) ?? [];
    list.push(run);
    runsByBuyer.set(run.recipientUserId, list);
  }
  const attributed: AttributedOrder[] = [];
  for (const order of orders) {
    const ordered = order.createdAt.getTime();
    const match = (runsByBuyer.get(order.buyerId) ?? [])
      .filter((run) => {
        const sent = run.sentAt.getTime();
        if (sent > ordered || ordered - sent > windowMs) return false;
        return !run.vendorId || order.items.some((item) => item.vendorId === run.vendorId);
      })
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
    if (!match) continue;
    const gross = match.vendorId
      ? order.items.filter((item) => item.vendorId === match.vendorId).reduce((sum, item) => sum + item.totalAmount, 0)
      : order.totalAmount;
    const refunded = order.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
    attributed.push({ type: match.type, currency: order.currency, gross, refunds: Math.min(refunded, gross) });
  }
  return attributed;
}

export const automationAttributionService = {
  async report(params: { vendorId?: string } = {}) {
    const windowDays = await launchSettingsService.get("ATTRIBUTION_WINDOW_DAYS");
    const since = new Date(Date.now() - REPORT_DAYS * DAY_MS);
    const vendorFilter = params.vendorId ? { vendorId: params.vendorId } : {};

    const rows = await prisma.automationRun.findMany({
      where: { status: "SENT", isTest: false, sentAt: { gte: since }, ...vendorFilter },
      select: { type: true, vendorId: true, recipientUserId: true, sentAt: true },
      orderBy: { sentAt: "desc" },
      take: MAX_RUNS,
    });
    const runs = rows.filter((run): run is typeof run & { sentAt: Date } => run.sentAt !== null);
    const buyerIds = [...new Set(runs.map((run) => run.recipientUserId))];

    const orders = buyerIds.length
      ? await prisma.order.findMany({
          where: { buyerId: { in: buyerIds }, isTest: false, status: { in: [...PAID_STATUSES] }, createdAt: { gte: since } },
          select: {
            id: true, buyerId: true, createdAt: true, totalAmount: true, currency: true,
            items: { select: { vendorId: true, totalAmount: true } },
          },
        })
      : [];

    const refunds = orders.length
      ? await prisma.refund.findMany({ where: { orderId: { in: orders.map((order) => order.id) }, status: "COMPLETED" }, select: { orderId: true, amountMinor: true } })
      : [];
    const withRefunds = orders.map((order) => ({ ...order, refunds: refunds.filter((refund) => refund.orderId === order.id) }));
    const attributed = attributeOrders(runs, withRefunds, windowDays * DAY_MS);
    const groups = new Map<string, { type: string; currency: string; orders: number; gross: number; refunds: number; net: number }>();
    for (const row of attributed) {
      const key = `${row.type}:${row.currency}`;
      const group = groups.get(key) ?? { type: row.type, currency: row.currency, orders: 0, gross: 0, refunds: 0, net: 0 };
      group.orders += 1;
      group.gross += row.gross;
      group.refunds += row.refunds;
      group.net += row.gross - row.refunds;
      groups.set(key, group);
    }

    const recovered = await prisma.renewal.findMany({
      where: {
        status: { in: ["PAID", "ORDER_CREATED"] },
        updatedAt: { gte: since },
        paymentAttempts: { some: { status: "FAILED" } },
        ...(params.vendorId ? { subscription: { offer: { vendorId: params.vendorId } } } : {}),
      },
      select: { subtotalAmount: true, deliveryFeeAmount: true, currency: true },
    });
    const recovery = new Map<string, { currency: string; count: number; amount: number }>();
    for (const renewal of recovered) {
      const entry = recovery.get(renewal.currency) ?? { currency: renewal.currency, count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += (renewal.subtotalAmount ?? 0) + (renewal.deliveryFeeAmount ?? 0);
      recovery.set(renewal.currency, entry);
    }

    const qualifiedReferrals = params.vendorId
      ? null
      : await prisma.vendorReferralCredit.count({ where: { status: { in: ["QUALIFIED", "RELEASED"] }, qualifiedAt: { gte: since } } });

    return {
      reportDays: REPORT_DAYS,
      windowDays,
      runsConsidered: runs.length,
      runsCapped: rows.length === MAX_RUNS,
      buyersReached: buyerIds.length,
      assisted: [...groups.values()].sort((a, b) => b.gross - a.gross),
      subscriptionRecovery: [...recovery.values()],
      qualifiedReferrals,
      estimatedIncremental: null,
      notes: {
        assisted: `Orders placed within ${windowDays} days of an automation reaching the buyer. This shows association, not proof the automation caused the order.`,
        net: "Net is after completed refunds. No automation gives a discount or has a recorded cost today, so neither is deducted.",
        incremental: "Estimated incremental revenue isn't shown, because it needs a comparison or holdout group and none exists yet.",
        recovery: "Renewals that failed at least once and were later paid.",
      },
    };
  },
};
