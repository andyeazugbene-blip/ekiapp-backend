/**
 * Handbook §3 — Action Centre. Server-side honest aggregates (no sampling):
 * every section reports a real count, value grouped by ORIGINAL currency
 * (never summed across currencies), oldest age and a drill-down href.
 * Each section is computed independently (Promise.allSettled) so one failing
 * query shows "unavailable" for that tile only. Test records (isTest) are
 * excluded unless `includeTest` was requested.
 */
import { OrderStatus, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { notTest, notTestOf, runWithTestScope } from "../../shared/utils/test-records";
import { adminRolesService, permissionMatches } from "./admin-roles.service";

export type Severity = "critical" | "high" | "medium" | "low" | "ok";

export interface MoneyByCurrency {
  currency: string;
  amountMinor: number;
  count: number;
}

export interface SectionItem {
  title: string;
  subtitle?: string;
  href: string;
  at?: string | null;
}

export interface ActionSection {
  key: string;
  title: string;
  description: string;
  /** "ok" = computed; "unavailable" = query failed; "not_monitored" = no data source. */
  state: "ok" | "unavailable" | "not_monitored";
  severity: Severity;
  count: number;
  values: MoneyByCurrency[];
  oldestAt: string | null;
  href: string;
  breakdown: Array<{ label: string; count: number; href?: string }>;
  items: SectionItem[];
  /** Free-text honest note, e.g. "Failed webhooks are not recorded". */
  note?: string;
  error?: string;
}

export interface ActionCentreKpis {
  gmv: MoneyByCurrency[];
  paidOrders: number;
  totalOrders: number;
  activeVendors30d: number;
  totalVendors: number;
  totalBuyers: number;
}

export interface ActionCentreResult {
  generatedAt: string;
  includeTest: boolean;
  thresholds: Record<string, string>;
  viewerPermissions: string[];
  sections: ActionSection[];
  kpis: ActionCentreKpis | null;
  kpisError?: string;
  badges: Record<string, number>;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const ACTION_CENTRE_THRESHOLDS = {
  pendingAcceptanceHours: 24,
  undeliveredOverdueDays: 7,
  payoutProcessingStuckHours: 24,
  campaignClosingSoonHours: 48,
  webhookStuckMinutes: 15,
  lookbackDays: 7,
} as const;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 };

const PAID_STATUSES: OrderStatus[] = [
  "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED",
];

/** Permissions (any-of) required to see each section. */
export const SECTION_PERMISSIONS: Record<string, string[]> = {
  paymentFailures: ["orders.read"],
  payoutExceptions: ["payouts.read"],
  orderRisk: ["orders.read"],
  disputes: ["disputes.read"],
  verification: ["verification.read"],
  vendorReadiness: ["vendors.read"],
  communityBuy: ["community_buy.read"],
  subscriptions: ["orders.read"],
  automation: ["analytics.read"],
  communications: ["communications.read", "communications.send"],
  conversations: ["support.read"],
  systemHealth: ["settings.read"],
};

function can(perms: string[], anyOf: string[]): boolean {
  return anyOf.some((p) => permissionMatches(perms, p));
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function minDate(...dates: Array<Date | null | undefined>): Date | null {
  const real = dates.filter((d): d is Date => !!d);
  return real.length ? new Date(Math.min(...real.map((d) => d.getTime()))) : null;
}

/** Merge money rows of the same currency; never mixes currencies. */
export function mergeMoney(...lists: MoneyByCurrency[][]): MoneyByCurrency[] {
  const map = new Map<string, MoneyByCurrency>();
  for (const list of lists) {
    for (const row of list) {
      const cur = map.get(row.currency) ?? { currency: row.currency, amountMinor: 0, count: 0 };
      cur.amountMinor += row.amountMinor;
      cur.count += row.count;
      map.set(row.currency, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.amountMinor - a.amountMinor);
}

function base(key: string, title: string, description: string, href: string): ActionSection {
  return {
    key, title, description, href, state: "ok", severity: "ok",
    count: 0, values: [], oldestAt: null, breakdown: [], items: [],
  };
}

function sev(count: number, level: Severity): Severity {
  return count > 0 ? level : "ok";
}

// ─── Sections ───────────────────────────────────────────────────────────────

async function paymentFailures(): Promise<ActionSection> {
  const since = new Date(Date.now() - ACTION_CENTRE_THRESHOLDS.lookbackDays * DAY);
  const where: Prisma.PaymentWhereInput = { status: "FAILED", createdAt: { gte: since }, ...notTest() };
  const [groups, recent] = await Promise.all([
    prisma.payment.groupBy({
      by: ["currency"], where,
      _count: { _all: true }, _sum: { amount: true }, _min: { createdAt: true },
    }),
    prisma.payment.findMany({
      where, orderBy: { createdAt: "desc" }, take: 5,
      select: { id: true, failureMessage: true, failureCode: true, createdAt: true, order: { select: { orderNumber: true } } },
    }),
  ]);
  const s = base("paymentFailures", "Payment failures", "Payments that FAILED in the last 7 days.", "/payments?status=FAILED");
  s.values = groups.map((g) => ({ currency: g.currency, amountMinor: g._sum.amount ?? 0, count: g._count._all }));
  s.count = groups.reduce((n, g) => n + g._count._all, 0);
  s.oldestAt = iso(minDate(...groups.map((g) => g._min.createdAt)));
  s.severity = sev(s.count, s.count >= 10 ? "critical" : "high");
  s.items = recent.map((p) => ({
    title: p.order?.orderNumber ? `Order ${p.order.orderNumber}` : "Payment",
    subtitle: p.failureMessage ?? p.failureCode ?? "No failure reason recorded",
    href: p.order?.orderNumber ? `/payments?status=FAILED&q=${encodeURIComponent(p.order.orderNumber)}` : "/payments?status=FAILED",
    at: iso(p.createdAt),
  }));
  return s;
}

async function payoutExceptions(): Promise<ActionSection> {
  const stuckBefore = new Date(Date.now() - ACTION_CENTRE_THRESHOLDS.payoutProcessingStuckHours * HOUR);
  const where: Prisma.PayoutRequestWhereInput = {
    ...notTestOf("vendor"),
    OR: [
      { status: { in: ["PENDING", "ON_HOLD"] } },
      { status: "PROCESSING", updatedAt: { lt: stuckBefore } },
    ],
  };
  const [groups, oldest] = await Promise.all([
    prisma.payoutRequest.groupBy({
      by: ["status", "currency"], where,
      _count: { _all: true }, _sum: { amount: true }, _min: { createdAt: true },
    }),
    prisma.payoutRequest.findMany({
      where, orderBy: { createdAt: "asc" }, take: 5,
      select: { id: true, status: true, amount: true, currency: true, createdAt: true, holdReason: true, vendor: { select: { storeName: true } } },
    }),
  ]);
  const s = base("payoutExceptions", "Payout exceptions", "Payout requests pending, on hold, or stuck processing.", "/payout-requests?status=PENDING");
  s.count = groups.reduce((n, g) => n + g._count._all, 0);
  s.values = mergeMoney(groups.map((g) => ({ currency: g.currency, amountMinor: g._sum.amount ?? 0, count: g._count._all })));
  s.oldestAt = iso(minDate(...groups.map((g) => g._min.createdAt)));
  const byStatus = new Map<string, number>();
  for (const g of groups) byStatus.set(g.status, (byStatus.get(g.status) ?? 0) + g._count._all);
  s.breakdown = [...byStatus.entries()].map(([status, count]) => ({
    label: status === "PROCESSING" ? "Stuck processing (24h+)" : status === "ON_HOLD" ? "On hold" : "Pending approval",
    count,
    href: `/payout-requests?status=${status}`,
  }));
  if (byStatus.has("ON_HOLD")) s.href = "/payout-requests?status=ON_HOLD";
  s.severity = sev(s.count, byStatus.has("ON_HOLD") || byStatus.has("PROCESSING") ? "high" : "medium");
  s.items = oldest.map((p) => ({
    title: p.vendor?.storeName ?? "Unknown vendor",
    subtitle: `${p.status}${p.holdReason ? ` — ${p.holdReason}` : ""}`,
    href: `/payout-requests?status=${p.status}`,
    at: iso(p.createdAt),
  }));
  return s;
}

async function orderRisk(): Promise<ActionSection> {
  const t = ACTION_CENTRE_THRESHOLDS;
  const pendingBefore = new Date(Date.now() - t.pendingAcceptanceHours * HOUR);
  const overdueBefore = new Date(Date.now() - t.undeliveredOverdueDays * DAY);
  const pendingWhere: Prisma.OrderWhereInput = {
    status: { in: ["PAID", "PAYMENT_SECURED"] }, vendorConfirmedAt: null, createdAt: { lt: pendingBefore }, ...notTest(),
  };
  const overdueWhere: Prisma.OrderWhereInput = {
    status: { in: ["CONFIRMED", "VENDOR_CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT"] },
    createdAt: { lt: overdueBefore }, ...notTest(),
  };
  const disputedWhere: Prisma.OrderWhereInput = { status: "DISPUTED", ...notTest() };
  const agg = (where: Prisma.OrderWhereInput) =>
    prisma.order.groupBy({
      by: ["currency"], where,
      _count: { _all: true }, _sum: { totalAmount: true }, _min: { createdAt: true },
    });
  const [pending, overdue, disputed] = await Promise.all([agg(pendingWhere), agg(overdueWhere), agg(disputedWhere)]);
  const toMoney = (rows: typeof pending): MoneyByCurrency[] =>
    rows.map((g) => ({ currency: g.currency, amountMinor: g._sum.totalAmount ?? 0, count: g._count._all }));
  const n = (rows: typeof pending) => rows.reduce((c, g) => c + g._count._all, 0);
  const s = base("orderRisk", "Order risk", "Orders awaiting vendor acceptance, overdue for delivery, or disputed.", "/orders?status=DISPUTED");
  s.count = n(pending) + n(overdue) + n(disputed);
  s.values = mergeMoney(toMoney(pending), toMoney(overdue), toMoney(disputed));
  s.oldestAt = iso(minDate(...[...pending, ...overdue, ...disputed].map((g) => g._min.createdAt)));
  s.breakdown = [
    { label: `Awaiting vendor acceptance > ${t.pendingAcceptanceHours}h`, count: n(pending), href: "/orders?status=PAID" },
    { label: `In fulfilment > ${t.undeliveredOverdueDays} days, not delivered`, count: n(overdue), href: "/orders?status=DISPATCHED" },
    { label: "Disputed", count: n(disputed), href: "/orders?status=DISPUTED" },
  ];
  s.href = n(disputed) > 0 ? "/orders?status=DISPUTED" : n(pending) > 0 ? "/orders?status=PAID" : "/orders?status=DISPATCHED";
  s.severity = sev(s.count, n(disputed) > 0 ? "high" : "medium");
  return s;
}

async function disputes(): Promise<ActionSection> {
  const [count, oldest, orders, recent] = await Promise.all([
    prisma.dispute.count({ where: { status: "OPEN", ...notTestOf("order") } }),
    prisma.dispute.aggregate({ where: { status: "OPEN", ...notTestOf("order") }, _min: { createdAt: true } }),
    prisma.order.groupBy({
      by: ["currency"],
      where: { dispute: { is: { status: "OPEN" } }, ...notTest() },
      _count: { _all: true }, _sum: { totalAmount: true },
    }),
    prisma.dispute.findMany({
      where: { status: "OPEN", ...notTestOf("order") }, orderBy: { createdAt: "asc" }, take: 5,
      select: { id: true, reason: true, createdAt: true, order: { select: { orderNumber: true } } },
    }),
  ]);
  const s = base("disputes", "Disputes needing action", "Open buyer/vendor disputes awaiting a decision.", "/disputes?status=OPEN");
  s.count = count;
  s.values = orders.map((g) => ({ currency: g.currency, amountMinor: g._sum.totalAmount ?? 0, count: g._count._all }));
  s.oldestAt = iso(oldest._min.createdAt);
  s.severity = sev(count, "high");
  s.items = recent.map((d) => ({
    title: d.order?.orderNumber ? `Order ${d.order.orderNumber}` : "Dispute",
    subtitle: d.reason,
    href: `/disputes?status=OPEN&q=${encodeURIComponent(d.order?.orderNumber ?? d.id)}`,
    at: iso(d.createdAt),
  }));
  return s;
}

async function verificationQueue(): Promise<ActionSection> {
  const where: Prisma.VendorWhereInput = { verificationStatus: "PENDING", ...notTest() };
  const [groups, oldest] = await Promise.all([
    prisma.vendor.groupBy({ by: ["stripeIdentityStatus"], where, _count: { _all: true } }),
    prisma.vendor.aggregate({ where, _min: { createdAt: true } }),
  ]);
  const s = base("verification", "Verification queue", "Vendors waiting for identity verification review.", "/verification?status=pending");
  s.count = groups.reduce((n, g) => n + g._count._all, 0);
  s.oldestAt = iso(oldest._min.createdAt);
  s.breakdown = groups.map((g) => ({
    label: g.stripeIdentityStatus ? `Provider: ${g.stripeIdentityStatus}` : "Provider: not started",
    count: g._count._all,
  }));
  s.severity = sev(s.count, "medium");
  return s;
}

async function vendorReadiness(): Promise<ActionSection> {
  const where: Prisma.VendorWhereInput = {
    verificationStatus: "VERIFIED", isSuspended: false, closedAt: null, ...notTest(),
    OR: [{ stripeChargesEnabled: false }, { stripePayoutsEnabled: false }],
  };
  const [count, oldest, recent] = await Promise.all([
    prisma.vendor.count({ where }),
    prisma.vendor.aggregate({ where, _min: { verifiedAt: true } }),
    prisma.vendor.findMany({
      where, orderBy: { verifiedAt: "asc" }, take: 5,
      select: { id: true, storeName: true, stripeChargesEnabled: true, stripePayoutsEnabled: true, stripeDisabledReason: true, verifiedAt: true },
    }),
  ]);
  const s = base("vendorReadiness", "Vendor readiness", "Verified vendors whose payments or payouts are not enabled.", "/vendors?payment=not_ready");
  s.count = count;
  s.oldestAt = iso(oldest._min.verifiedAt);
  s.severity = sev(count, "medium");
  s.items = recent.map((v) => ({
    title: v.storeName,
    subtitle: [!v.stripeChargesEnabled && "charges disabled", !v.stripePayoutsEnabled && "payouts disabled", v.stripeDisabledReason].filter(Boolean).join(" · "),
    href: `/vendors/${v.id}`,
    at: iso(v.verifiedAt),
  }));
  return s;
}

async function communityBuy(): Promise<ActionSection> {
  const now = new Date();
  const soon = new Date(Date.now() + ACTION_CENTRE_THRESHOLDS.campaignClosingSoonHours * HOUR);
  const belowTargetStatuses = ["CLOSING", "RESCUE_WINDOW", "DECISION_REQUIRED", "AWAITING_SUPPLIER_RECONFIRMATION"] as const;
  const [closingSoon, belowTarget, fulfilmentLate, refunds] = await Promise.all([
    prisma.communityCampaign.count({ where: { status: "LIVE", deadline: { gte: now, lte: soon } } }),
    prisma.communityCampaign.count({ where: { status: { in: [...belowTargetStatuses] } } }),
    prisma.supplierFulfilmentAlert.count({ where: { status: { in: ["OPEN", "CONTACTED", "ESCALATED"] } } }),
    prisma.campaignRefund.groupBy({
      by: ["currency"], where: { status: { in: ["REFUND_PENDING", "REFUND_PROCESSING", "REFUND_FAILED"] } },
      _count: { _all: true }, _sum: { amount: true }, _min: { createdAt: true },
    }),
  ]);
  const refundCount = refunds.reduce((n, g) => n + g._count._all, 0);
  const s = base("communityBuy", "Community Buy risk", "Campaigns closing soon, below target, late fulfilment and pending refunds.", "/community-campaigns");
  s.count = closingSoon + belowTarget + fulfilmentLate + refundCount;
  s.values = refunds.map((g) => ({ currency: g.currency, amountMinor: g._sum.amount ?? 0, count: g._count._all }));
  s.oldestAt = iso(minDate(...refunds.map((g) => g._min.createdAt)));
  s.breakdown = [
    { label: `Closing within ${ACTION_CENTRE_THRESHOLDS.campaignClosingSoonHours}h`, count: closingSoon, href: "/community-campaigns" },
    { label: "Below target / awaiting decision", count: belowTarget, href: "/community-campaigns" },
    { label: "Fulfilment late", count: fulfilmentLate, href: "/fulfilment-delays" },
    { label: "Refunds pending or failed", count: refundCount, href: "/community-refunds" },
  ];
  s.href = refundCount > 0 ? "/community-refunds" : fulfilmentLate > 0 ? "/fulfilment-delays" : "/community-campaigns";
  s.severity = sev(s.count, refundCount > 0 || fulfilmentLate > 0 ? "high" : "medium");
  s.note = "Value shown is pending/failed campaign refunds only.";
  return s;
}

async function subscriptionRisk(): Promise<ActionSection> {
  const where: Prisma.RenewalWhereInput = {
    status: { in: ["PAYMENT_FAILED", "AWAITING_STOCK", "AWAITING_PRICE_APPROVAL"] },
    ...(notTest().isTest === false ? { subscription: { buyer: { isTest: false } } } : {}),
  };
  const groups = await prisma.renewal.groupBy({
    by: ["status", "currency"], where,
    _count: { _all: true }, _sum: { subtotalAmount: true }, _min: { createdAt: true },
  });
  const s = base("subscriptions", "Foodstuffs Subscription risk", "Renewals with failed payment, awaiting stock, or awaiting price approval.", "/subscription-exceptions");
  s.count = groups.reduce((n, g) => n + g._count._all, 0);
  s.values = mergeMoney(groups.map((g) => ({ currency: g.currency, amountMinor: g._sum.subtotalAmount ?? 0, count: g._count._all })));
  s.oldestAt = iso(minDate(...groups.map((g) => g._min.createdAt)));
  const byStatus = new Map<string, number>();
  for (const g of groups) byStatus.set(g.status, (byStatus.get(g.status) ?? 0) + g._count._all);
  const labels: Record<string, string> = {
    PAYMENT_FAILED: "Payment failed", AWAITING_STOCK: "Awaiting stock", AWAITING_PRICE_APPROVAL: "Awaiting price approval",
  };
  s.breakdown = [...byStatus.entries()].map(([k, count]) => ({ label: labels[k] ?? k, count, href: `/subscription-exceptions?status=${k}` }));
  s.severity = sev(s.count, byStatus.has("PAYMENT_FAILED") ? "high" : "medium");
  return s;
}

async function automationFailures(): Promise<ActionSection> {
  const since = new Date(Date.now() - ACTION_CENTRE_THRESHOLDS.lookbackDays * DAY);
  const recipient = notTestOf("recipient");
  const [groups, lastSuccess] = await Promise.all([
    prisma.automationRun.groupBy({
      by: ["status"],
      where: { status: { in: ["FAILED", "SUPPRESSED"] }, createdAt: { gte: since }, ...recipient },
      _count: { _all: true }, _min: { createdAt: true },
    }),
    prisma.automationRun.aggregate({ where: { status: "SENT", ...recipient }, _max: { sentAt: true } }),
  ]);
  const s = base("automation", "Automation failures", "Automation runs that FAILED or were SUPPRESSED in the last 7 days.", "/automation");
  s.count = groups.reduce((n, g) => n + g._count._all, 0);
  s.oldestAt = iso(minDate(...groups.map((g) => g._min.createdAt)));
  s.breakdown = groups.map((g) => ({ label: g.status === "FAILED" ? "Failed" : "Suppressed", count: g._count._all }));
  const failed = groups.find((g) => g.status === "FAILED")?._count._all ?? 0;
  s.severity = failed > 0 ? "medium" : s.count > 0 ? "low" : "ok";
  s.note = lastSuccess._max.sentAt ? `Last successful send: ${lastSuccess._max.sentAt.toISOString()}` : "No successful automation send recorded yet.";
  return s;
}

async function communicationsHealth(): Promise<ActionSection> {
  const since = new Date(Date.now() - ACTION_CENTRE_THRESHOLDS.lookbackDays * DAY);
  const overdueBefore = new Date(Date.now() - 15 * 60 * 1000);
  const [scheduled, overdue, failed, oldestFail] = await Promise.all([
    prisma.scheduledCommunication.count({ where: { status: "SCHEDULED" } }),
    prisma.scheduledCommunication.count({ where: { status: "SCHEDULED", scheduledFor: { lt: overdueBefore } } }),
    prisma.scheduledCommunication.count({ where: { status: { in: ["FAILED", "PARTIAL"] }, updatedAt: { gte: since } } }),
    prisma.scheduledCommunication.aggregate({ where: { status: { in: ["FAILED", "PARTIAL"] }, updatedAt: { gte: since } }, _min: { updatedAt: true } }),
  ]);
  const s = base("communications", "Communications", "Scheduled sends, and failed or partial sends in the last 7 days.", "/communications");
  s.count = failed + overdue;
  s.oldestAt = iso(oldestFail._min.updatedAt);
  s.breakdown = [
    { label: "Scheduled (upcoming)", count: scheduled - overdue },
    { label: "Overdue — not sent 15m+ after schedule", count: overdue },
    { label: "Failed or partial (7d)", count: failed },
  ];
  s.severity = sev(s.count, failed > 0 ? "medium" : "low");
  return s;
}

async function conversations(): Promise<ActionSection> {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
  const adminIds = admins.map((a) => a.id);
  const unreadWhere: Prisma.MessageWhereInput = {
    readAt: null, isInternal: false, senderId: { notIn: adminIds },
    conversation: { type: "SUPPORT", status: "OPEN" },
  };
  const [unread, oldestUnread, escalated] = await Promise.all([
    prisma.message.count({ where: unreadWhere }),
    prisma.message.aggregate({ where: unreadWhere, _min: { createdAt: true } }),
    prisma.conversation.count({ where: { type: "SUPPORT", status: "OPEN", escalatedAt: { not: null } } }),
  ]);
  const s = base("conversations", "Conversations", "Unread buyer support messages and escalated threads.", "/support-messages?status=unread");
  s.count = unread + escalated;
  s.oldestAt = iso(oldestUnread._min.createdAt);
  s.breakdown = [
    { label: "Unread messages", count: unread, href: "/support-messages?status=unread" },
    { label: "Escalated threads", count: escalated, href: "/support-messages?status=escalated" },
  ];
  s.severity = sev(s.count, escalated > 0 ? "high" : "medium");
  return s;
}

async function systemHealth(): Promise<ActionSection> {
  const since = new Date(Date.now() - DAY);
  const stuckBefore = new Date(Date.now() - ACTION_CENTRE_THRESHOLDS.webhookStuckMinutes * 60 * 1000);
  const [total, stuck, oldest] = await Promise.all([
    prisma.webhookEvent.count({ where: { createdAt: { gte: since } } }),
    prisma.webhookEvent.count({ where: { status: "PROCESSING", createdAt: { gte: since, lt: stuckBefore } } }),
    prisma.webhookEvent.aggregate({ where: { status: "PROCESSING", createdAt: { gte: since, lt: stuckBefore } }, _min: { createdAt: true } }),
  ]);
  const s = base("systemHealth", "System health", "Provider webhook events stuck in PROCESSING (last 24h).", "/settings?tab=integrations");
  s.count = stuck;
  s.oldestAt = iso(oldest._min.createdAt);
  s.severity = sev(stuck, "high");
  s.breakdown = [{ label: "Webhook events received (24h)", count: total }];
  s.note = "Failed webhook deliveries are not recorded; only events stuck in PROCESSING can be detected. Queue/worker and email provider health are not monitored here.";
  if (total === 0) s.note = `No webhook events received in the last 24h. ${s.note}`;
  return s;
}

async function computeKpis(): Promise<ActionCentreKpis> {
  const thirty = new Date(Date.now() - 30 * DAY);
  const [gmv, totalOrders, active, totalVendors, totalBuyers] = await Promise.all([
    prisma.order.groupBy({
      by: ["currency"], where: { status: { in: PAID_STATUSES }, ...notTest() },
      _count: { _all: true }, _sum: { totalAmount: true },
    }),
    prisma.order.count({ where: { status: { notIn: ["FAILED", "CANCELLED"] }, ...notTest() } }),
    prisma.order.findMany({
      where: { status: { in: PAID_STATUSES }, createdAt: { gte: thirty }, vendorId: { not: null }, ...notTest() },
      select: { vendorId: true }, distinct: ["vendorId"],
    }),
    prisma.vendor.count({ where: notTest() }),
    prisma.user.count({ where: { role: "BUYER", ...notTest() } }),
  ]);
  return {
    gmv: gmv.map((g) => ({ currency: g.currency, amountMinor: g._sum.totalAmount ?? 0, count: g._count._all })),
    paidOrders: gmv.reduce((n, g) => n + g._count._all, 0),
    totalOrders,
    activeVendors30d: active.length,
    totalVendors,
    totalBuyers,
  };
}

const BUILDERS: Record<string, { title: string; run: () => Promise<ActionSection> }> = {
  paymentFailures: { title: "Payment failures", run: paymentFailures },
  payoutExceptions: { title: "Payout exceptions", run: payoutExceptions },
  orderRisk: { title: "Order risk", run: orderRisk },
  disputes: { title: "Disputes needing action", run: disputes },
  verification: { title: "Verification queue", run: verificationQueue },
  vendorReadiness: { title: "Vendor readiness", run: vendorReadiness },
  communityBuy: { title: "Community Buy risk", run: communityBuy },
  subscriptions: { title: "Foodstuffs Subscription risk", run: subscriptionRisk },
  automation: { title: "Automation failures", run: automationFailures },
  communications: { title: "Communications", run: communicationsHealth },
  conversations: { title: "Conversations", run: conversations },
  systemHealth: { title: "System health", run: systemHealth },
};

export async function getActionCentre(
  viewerId: string,
  options: { includeTest?: boolean } = {},
): Promise<ActionCentreResult> {
  const includeTest = options.includeTest === true;
  const perms = await adminRolesService.userPermissions(viewerId);
  const keys = Object.keys(BUILDERS).filter((k) => can(perms, SECTION_PERMISSIONS[k] ?? []));

  return runWithTestScope(includeTest, async () => {
    const settled = await Promise.allSettled(keys.map((k) => BUILDERS[k].run()));
    const sections: ActionSection[] = settled.map((res, i) => {
      if (res.status === "fulfilled") return res.value;
      const key = keys[i];
      logger.error("Action centre section failed", {
        section: key, errorMessage: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
      const failed = base(key, BUILDERS[key].title, "", "/dashboard");
      failed.state = "unavailable";
      failed.error = "Data unavailable";
      return failed;
    });

    let kpis: ActionCentreKpis | null = null;
    let kpisError: string | undefined;
    if (can(perms, ["analytics.read", "dashboard.read"])) {
      try {
        kpis = await computeKpis();
      } catch (error) {
        kpisError = "Data unavailable";
        logger.error("Action centre KPIs failed", { errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }

    sections.sort((a, b) => {
      const ua = a.state === "unavailable" ? 1 : 0;
      const ub = b.state === "unavailable" ? 1 : 0;
      if (ua !== ub) return ua - ub;
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count;
    });

    const count = (key: string) => sections.find((s) => s.key === key && s.state === "ok")?.count;
    const badges: Record<string, number> = {};
    for (const [badge, key] of [
      ["verification", "verification"], ["disputes", "disputes"], ["payments", "paymentFailures"],
      ["conversations", "conversations"], ["subscriptions", "subscriptions"],
    ] as const) {
      const c = count(key);
      if (c !== undefined) badges[badge] = c;
    }

    return {
      generatedAt: new Date().toISOString(),
      includeTest,
      thresholds: {
        pendingAcceptance: `${ACTION_CENTRE_THRESHOLDS.pendingAcceptanceHours}h`,
        undeliveredOverdue: `${ACTION_CENTRE_THRESHOLDS.undeliveredOverdueDays}d`,
        failureLookback: `${ACTION_CENTRE_THRESHOLDS.lookbackDays}d`,
        webhookStuck: `${ACTION_CENTRE_THRESHOLDS.webhookStuckMinutes}m`,
      },
      viewerPermissions: perms,
      sections,
      kpis,
      kpisError,
      badges,
    };
  });
}
