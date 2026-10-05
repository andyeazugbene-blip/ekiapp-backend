import type { Prisma, SubscriptionFrequency } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notificationsService } from "../notifications/notifications.service";
import { buyerSubscriptionsService, parseRescheduleDate, subscriptionLifecycle } from "./buyer-subscriptions.service";
import { renewalsService } from "./renewals.service";

/**
 * Foodstuffs Subscription admin module (handbook section 9 / gap B11).
 * Read side: queue list with counts + full detail timeline + reports.
 * Write side: pause / resume / skip next / set next date / change frequency /
 * retry payment — each needs a reason (min 5 chars, validated here, server
 * side), writes an AuditLog row with before/after and notifies the buyer.
 * Cancel lives in renewalsService.adminForceCancel (same rules).
 */

export const SUBSCRIPTION_QUEUES = [
  "all",
  "active",
  "paused",
  "skip-requested",
  "renewal-due",
  "payment-failed",
  "stock-exception",
  "cancelled",
] as const;
export type SubscriptionQueue = (typeof SUBSCRIPTION_QUEUES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWAL_DUE_WINDOW_DAYS = 3;
const SKIP_WINDOW_DAYS = 14;

export function requireReason(raw: unknown, label = "reason"): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 5) throw new AppError(`A ${label} of at least 5 characters is required`, 400, undefined, "REASON_REQUIRED");
  if (reason.length > 500) throw new AppError(`The ${label} is too long (max 500 characters)`, 400);
  return reason;
}

function queueWhere(queue: SubscriptionQueue, now = new Date()): Prisma.BuyerSubscriptionWhereInput {
  switch (queue) {
    case "active":
      return { status: "ACTIVE" };
    case "paused":
      return { status: "PAUSED" };
    case "skip-requested":
      return {
        status: "ACTIVE",
        actionHistory: {
          some: { action: { in: ["skipped_next", "admin_skipped_next"] }, createdAt: { gte: new Date(now.getTime() - SKIP_WINDOW_DAYS * DAY_MS) } },
        },
      };
    case "renewal-due":
      return { status: "ACTIVE", nextRenewalAt: { lte: new Date(now.getTime() + RENEWAL_DUE_WINDOW_DAYS * DAY_MS) } };
    case "payment-failed":
      return {
        OR: [
          { status: "PAYMENT_ATTENTION" },
          { status: "PAUSED", pausedReason: "payment_failed" },
          { renewals: { some: { status: "PAYMENT_FAILED" } } },
        ],
      };
    case "stock-exception":
      return { renewals: { some: { status: "AWAITING_STOCK" } } };
    case "cancelled":
      return { status: "CANCELLED" };
    default:
      return {};
  }
}

export interface AdminSubscriptionListQuery {
  status?: string;
  vendorId?: string;
  q?: string;
  renewalFrom?: string;
  renewalTo?: string;
  cursor?: string;
  limit?: number;
}

function parseDate(raw?: string, endOfDay = false): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new AppError("Invalid date filter", 400);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) d.setUTCHours(23, 59, 59, 999);
  return d;
}

function paymentState(latest?: { status: string } | null): string {
  if (!latest) return "none";
  switch (latest.status) {
    case "ORDER_CREATED":
    case "PAID":
      return "paid";
    case "PAYMENT_FAILED":
      return "failed";
    case "PAYMENT_PROCESSING":
      return "processing";
    case "READY_FOR_PAYMENT":
      return "ready";
    case "CANCELLED":
      return "cancelled";
    default:
      return "pending";
  }
}

export const subscriptionAdminService = {
  async list(query: AdminSubscriptionListQuery) {
    const queue = (SUBSCRIPTION_QUEUES as readonly string[]).includes(query.status ?? "") ? (query.status as SubscriptionQueue) : "all";
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const now = new Date();

    const base: Prisma.BuyerSubscriptionWhereInput[] = [];
    if (query.vendorId) base.push({ offer: { vendorId: query.vendorId } });
    const q = query.q?.trim();
    if (q) {
      base.push({
        OR: [
          { id: q },
          { buyer: { name: { contains: q, mode: "insensitive" } } },
          { buyer: { email: { contains: q, mode: "insensitive" } } },
          { offer: { vendor: { storeName: { contains: q, mode: "insensitive" } } } },
        ],
      });
    }
    const from = parseDate(query.renewalFrom);
    const to = parseDate(query.renewalTo, true);
    if (from || to) base.push({ nextRenewalAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });

    const whereFor = (key: SubscriptionQueue): Prisma.BuyerSubscriptionWhereInput => ({ AND: [...base, queueWhere(key, now)] });

    const [rows, countEntries] = await Promise.all([
      prisma.buyerSubscription.findMany({
        where: whereFor(queue),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: {
          buyer: { select: { id: true, name: true, email: true } },
          offer: { select: { id: true, title: true, vendorId: true, vendor: { select: { id: true, storeName: true } } } },
          items: { include: { product: { select: { title: true, currency: true } } } },
          renewals: { orderBy: { cycleDate: "desc" }, take: 1, select: { id: true, status: true, cycleDate: true, failureReason: true, nextRetryAt: true, currency: true, subtotalAmount: true } },
        },
      }),
      Promise.all(SUBSCRIPTION_QUEUES.map(async (key) => [key, await prisma.buyerSubscription.count({ where: whereFor(key) })] as const)),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((s) => {
      const latest = s.renewals[0] ?? null;
      return {
        id: s.id,
        status: s.status,
        frequency: s.frequency,
        nextRenewalAt: s.nextRenewalAt,
        pausedUntil: s.pausedUntil,
        pausedReason: s.pausedReason,
        cancelReason: s.cancelReason,
        createdAt: s.createdAt,
        buyer: s.buyer,
        vendor: s.offer.vendor,
        offerTitle: s.offer.title,
        basket: s.items.map((i) => ({ title: i.product.title, quantity: i.quantity })),
        currency: s.items[0]?.product.currency ?? latest?.currency ?? null,
        latestRenewal: latest,
        paymentState: paymentState(latest),
      };
    });
    return { items, nextCursor: hasMore ? page[page.length - 1].id : null, counts: Object.fromEntries(countEntries) as Record<SubscriptionQueue, number> };
  },

  async detail(id: string) {
    const sub = await prisma.buyerSubscription.findUnique({
      where: { id },
      include: {
        buyer: { select: { id: true, name: true, email: true, phone: true } },
        offer: { include: { vendor: { select: { id: true, storeName: true, country: true, city: true } } } },
        deliveryAddress: true,
        paymentMethod: { select: { id: true, brand: true, last4: true } },
        items: { include: { product: { select: { id: true, title: true, priceInCents: true, currency: true, stock: true, isActive: true } } } },
        renewals: {
          orderBy: { cycleDate: "desc" },
          take: 50,
          include: {
            items: { include: { product: { select: { title: true } } } },
            paymentAttempts: { orderBy: { attemptNumber: "asc" } },
            order: { select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true } },
          },
        },
        actionHistory: { orderBy: { createdAt: "desc" }, take: 200 },
      },
    });
    if (!sub) throw new AppError("Subscription not found", 404);

    const renewalIds = sub.renewals.map((r) => r.id);
    const orderIds = sub.renewals.map((r) => r.order?.id).filter((v): v is string => !!v);
    const [audit, refunds] = await Promise.all([
      prisma.auditLog.findMany({
        where: { OR: [{ entityType: "BuyerSubscription", entityId: id }, { entityType: "Renewal", entityId: { in: renewalIds } }] },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      orderIds.length ? prisma.refund.findMany({ where: { orderId: { in: orderIds } }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
    ]);

    const actorIds = [...new Set([...audit.map((a) => a.actorId), ...sub.actionHistory.map((h) => h.actorUserId).filter((v): v is string => !!v)])]
      .filter((a) => !a.startsWith("system:"));
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }) : [];
    const actorName = (actorId?: string | null): string => {
      if (!actorId) return "System";
      if (actorId.startsWith("system:")) return "System";
      if (actorId === sub.buyerId) return `${sub.buyer.name} (buyer)`;
      const a = actors.find((u) => u.id === actorId);
      return a ? a.name || a.email : "Unknown user";
    };

    const discount = sub.offer.discountPercent ?? 0;
    const basket = sub.items.map((i) => {
      const unit = discount > 0 ? Math.round(i.product.priceInCents * (1 - discount / 100)) : i.product.priceInCents;
      return {
        id: i.id,
        productId: i.productId,
        title: i.product.title,
        quantity: i.quantity,
        unitAmount: unit,
        lineAmount: unit * i.quantity,
        currency: i.product.currency,
        stockAvailable: i.product.isActive && i.product.stock >= i.quantity,
        stock: i.product.stock,
        productActive: i.product.isActive,
      };
    });
    const latest = sub.renewals[0] ?? null;

    type Event = { at: Date; kind: string; title: string; detail?: string | null; actor?: string | null; ref?: { type: string; id: string } };
    const events: Event[] = [];
    for (const h of sub.actionHistory) {
      const meta = (h.metadata ?? {}) as Record<string, unknown>;
      events.push({
        at: h.createdAt,
        kind: "action",
        title: HISTORY_LABELS[h.action] ?? h.action.replace(/_/g, " "),
        detail: typeof meta.reason === "string" ? meta.reason : null,
        actor: actorName(h.actorUserId),
      });
    }
    for (const r of sub.renewals) {
      events.push({ at: r.createdAt, kind: "renewal", title: `Cycle ${r.cycleDate.toISOString().slice(0, 10)} prepared`, detail: `Status now: ${r.status.replace(/_/g, " ").toLowerCase()}`, ref: { type: "renewal", id: r.id } });
      for (const p of r.paymentAttempts) {
        events.push({
          at: p.createdAt,
          kind: "payment_attempt",
          title: `Payment attempt ${p.attemptNumber}: ${p.status.toLowerCase()}`,
          detail: p.failureMessage ?? p.failureCode ?? null,
          ref: { type: "renewal", id: r.id },
        });
      }
      if (r.order) {
        events.push({ at: r.order.createdAt, kind: "order", title: `Order ${r.order.orderNumber} created`, detail: `Status ${r.order.status.toLowerCase()}`, ref: { type: "order", id: r.order.id } });
      }
    }
    for (const rf of refunds) {
      events.push({ at: rf.createdAt, kind: "refund", title: `Refund ${rf.status.toLowerCase()}`, detail: rf.reason, ref: { type: "order", id: rf.orderId } });
    }
    for (const a of audit) {
      events.push({ at: a.createdAt, kind: "audit", title: a.action, detail: a.reason ?? null, actor: actorName(a.actorId) });
    }
    events.sort((a, b) => b.at.getTime() - a.at.getTime());

    const canAct = {
      pause: sub.status === "ACTIVE",
      resume: sub.status === "PAUSED",
      skipNext: sub.status === "ACTIVE" && !!sub.nextRenewalAt,
      setNextDate: sub.status === "ACTIVE",
      changeFrequency: sub.status === "ACTIVE",
      cancel: sub.status !== "CANCELLED",
      retryPayment: sub.renewals.some((r) => r.status === "PAYMENT_FAILED"),
    };

    return {
      subscription: {
        id: sub.id,
        status: sub.status,
        frequency: sub.frequency,
        nextRenewalAt: sub.nextRenewalAt,
        pausedUntil: sub.pausedUntil,
        pausedReason: sub.pausedReason,
        pausedAt: sub.pausedAt,
        cancelledAt: sub.cancelledAt,
        cancelReason: sub.cancelReason,
        priceChangeApprovalLimitBps: sub.priceChangeApprovalLimitBps,
        createdAt: sub.createdAt,
      },
      buyer: sub.buyer,
      vendor: sub.offer.vendor,
      offer: {
        id: sub.offer.id,
        title: sub.offer.title,
        frequencies: sub.offer.frequencies,
        fulfilmentMethod: sub.offer.fulfilmentMethod,
        substitutionMode: sub.offer.substitutionMode,
        discountPercent: sub.offer.discountPercent,
        renewalsPaused: sub.offer.renewalsPaused,
      },
      recipient: {
        line1: sub.deliveryAddress.line1,
        city: sub.deliveryAddress.city,
        country: sub.deliveryAddress.country,
      },
      paymentMethod: sub.paymentMethod,
      basket,
      money: {
        currency: latest?.currency ?? basket[0]?.currency ?? null,
        basketSubtotal: basket.reduce((s, b) => s + b.lineAmount, 0),
        latestSubtotal: latest?.subtotalAmount ?? null,
        latestDeliveryFee: latest?.deliveryFeeAmount ?? null,
        paymentState: paymentState(latest),
        latestFailureReason: latest?.failureReason ?? null,
        nextRetryAt: latest?.nextRetryAt ?? null,
      },
      renewals: sub.renewals.map((r) => ({
        id: r.id,
        cycleDate: r.cycleDate,
        status: r.status,
        currency: r.currency,
        subtotalAmount: r.subtotalAmount,
        deliveryFeeAmount: r.deliveryFeeAmount,
        failureReason: r.failureReason,
        nextRetryAt: r.nextRetryAt,
        escalated: r.escalated,
        attempts: r.paymentAttempts.map((p) => ({ attemptNumber: p.attemptNumber, status: p.status, failureCode: p.failureCode, failureMessage: p.failureMessage, createdAt: p.createdAt })),
        order: r.order,
        items: r.items.map((i) => ({ title: i.product.title, quantity: i.quantity, unitAmount: i.currentUnitPrice, stockAvailable: i.stockAvailable })),
      })),
      linkedOrders: sub.renewals.filter((r) => r.order).map((r) => r.order),
      timeline: events.map((e) => ({ ...e, at: e.at.toISOString() })),
      canAct,
    };
  },

  async reports(daysRaw?: number) {
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const since = new Date(Date.now() - days * DAY_MS);

    const [active, paidRenewals, cancelled, reasonRows, failedCycles, cycleStatusRows] = await Promise.all([
      prisma.buyerSubscription.count({ where: { status: "ACTIVE" } }),
      prisma.renewal.findMany({
        where: { status: { in: ["PAID", "ORDER_CREATED"] }, updatedAt: { gte: since } },
        select: { currency: true, subtotalAmount: true, deliveryFeeAmount: true },
      }),
      prisma.buyerSubscription.count({ where: { status: "CANCELLED", cancelledAt: { gte: since } } }),
      prisma.buyerSubscription.groupBy({ by: ["cancelReason"], where: { status: "CANCELLED", cancelledAt: { gte: since } }, _count: { _all: true } }),
      prisma.renewal.findMany({
        where: { createdAt: { gte: since }, paymentAttempts: { some: { status: "FAILED" } } },
        select: { status: true },
      }),
      prisma.renewal.groupBy({ by: ["status"], where: { cycleDate: { gte: since, lte: new Date() } }, _count: { _all: true } }),
    ]);

    const revenue = new Map<string, number>();
    for (const r of paidRenewals) revenue.set(r.currency, (revenue.get(r.currency) ?? 0) + (r.subtotalAmount ?? 0) + (r.deliveryFeeAmount ?? 0));

    const recovered = failedCycles.filter((r) => r.status === "PAID" || r.status === "ORDER_CREATED").length;
    const cycle = Object.fromEntries(cycleStatusRows.map((r) => [r.status, r._count._all])) as Record<string, number>;
    const delivered = (cycle.ORDER_CREATED ?? 0) + (cycle.PAID ?? 0);
    const failed = (cycle.CANCELLED ?? 0) + (cycle.EXPIRED ?? 0) + (cycle.PAYMENT_FAILED ?? 0);

    const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
    return {
      periodDays: days,
      since,
      activeSubscriptions: active,
      recurringRevenue: [...revenue.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor })),
      churn: { cancelledInPeriod: cancelled, ratePct: pct(cancelled, active + cancelled), rateBasis: "cancelled / (active now + cancelled in period)" },
      paymentRecovery: { cyclesWithFailedPayment: failedCycles.length, recovered, ratePct: pct(recovered, failedCycles.length) },
      fulfilment: { cyclesDue: delivered + failed, ordersCreated: delivered, failedOrCancelled: failed, skipped: cycle.SKIPPED ?? 0, successRatePct: pct(delivered, delivered + failed) },
      cancellationReasons: reasonRows
        .map((r) => ({ reason: r.cancelReason ?? "Not provided", count: r._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  },

  // ─── Admin mutations ──────────────────────────────────────────────────

  async pause(adminId: string, id: string, reasonRaw: unknown, resumeAtRaw: unknown, request?: any) {
    const reason = requireReason(reasonRaw);
    const sub = await requireSub(id);
    const resumeAt = resumeAtRaw ? parseRescheduleDate(resumeAtRaw) : undefined;
    const updated = await subscriptionLifecycle.pause(sub, adminId, { by: "admin", resumeAt, reason });
    await audit(adminId, "subscription.admin_pause", id, sub, updated, reason, request, { resumeAt: resumeAt?.toISOString() ?? null });
    await notifyBuyer(sub.buyerId, id, "admin_paused", "Your Foodstuffs Subscription was paused", `Eki support paused your Foodstuffs Subscription${resumeAt ? ` until ${resumeAt.toDateString()}` : ""}. Reason: ${reason}. You can resume it in the app.`);
    return updated;
  },

  async resume(adminId: string, id: string, reasonRaw: unknown, request?: any) {
    const reason = requireReason(reasonRaw);
    const sub = await requireSub(id);
    const updated = await subscriptionLifecycle.resume(sub, adminId, { by: "admin", reason });
    await audit(adminId, "subscription.admin_resume", id, sub, updated, reason, request);
    await notifyBuyer(sub.buyerId, id, "admin_resumed", "Your Foodstuffs Subscription is active again", `Eki support resumed your Foodstuffs Subscription. Next delivery is prepared on ${updated.nextRenewalAt?.toDateString() ?? "the next scheduled run"}.`);
    return updated;
  },

  async skipNext(adminId: string, id: string, reasonRaw: unknown, request?: any) {
    const reason = requireReason(reasonRaw);
    const sub = await requireSub(id);
    const updated = await subscriptionLifecycle.skipNext(sub, adminId, { by: "admin", reason });
    await audit(adminId, "subscription.admin_skip_next", id, sub, updated, reason, request);
    await notifyBuyer(sub.buyerId, id, "admin_skipped_next", "Your next Foodstuffs Subscription delivery was skipped", `Eki support skipped your next delivery. Reason: ${reason}. Your next delivery is on ${updated.nextRenewalAt?.toDateString() ?? "the following cycle"}. You have not been charged for the skipped one.`);
    return updated;
  },

  async setNextDate(adminId: string, id: string, rawDate: unknown, reasonRaw: unknown, request?: any) {
    const reason = requireReason(reasonRaw);
    const date = parseRescheduleDate(rawDate);
    const sub = await requireSub(id);
    const updated = await subscriptionLifecycle.reschedule(sub, date, adminId, { by: "admin", reason });
    await audit(adminId, "subscription.admin_set_next_date", id, sub, updated, reason, request);
    await notifyBuyer(sub.buyerId, id, "admin_rescheduled", "Your Foodstuffs Subscription delivery date changed", `Eki support moved your next delivery to ${date.toDateString()}. Reason: ${reason}.`);
    return updated;
  },

  async changeFrequency(adminId: string, id: string, frequency: unknown, reasonRaw: unknown, request?: any) {
    const reason = requireReason(reasonRaw);
    if (typeof frequency !== "string" || !["WEEKLY", "BIWEEKLY", "EVERY_4_WEEKS", "MONTHLY"].includes(frequency)) {
      throw new AppError("A valid frequency is required", 400);
    }
    const before = await requireSub(id);
    const result = await buyerSubscriptionsService.adminChangeFrequency(adminId, id, frequency as SubscriptionFrequency, reason);
    await audit(adminId, "subscription.admin_change_frequency", id, before, result.updated, reason, request);
    return result;
  },

  /**
   * Retry payment. `id` may be a renewal id (legacy exceptions queue) or a
   * subscription id (detail page -> its failed renewal). Goes through the same
   * idempotent attemptPayment() as the buyer retry and the sweep: no new charge path.
   */
  async retryPayment(adminId: string, id: string, reasonRaw: unknown, request?: any) {
    const reason = requireReason(reasonRaw);
    let renewal = await prisma.renewal.findUnique({ where: { id } });
    if (!renewal) {
      renewal = await prisma.renewal.findFirst({ where: { subscriptionId: id, status: "PAYMENT_FAILED" }, orderBy: { cycleDate: "desc" } });
    }
    if (!renewal) throw new AppError("No failed payment found to retry", 404);
    const before = { status: renewal.status, failureReason: renewal.failureReason };
    const result = await renewalsService.adminRetryPayment(renewal.id);
    await recordAudit({
      actorId: adminId,
      action: "renewal.admin_retry_payment",
      entityType: "Renewal",
      entityId: renewal.id,
      beforeState: before,
      afterState: result ? { status: result.status } : undefined,
      reason,
      metadata: { subscriptionId: renewal.subscriptionId },
      request,
    });
    const sub = await prisma.buyerSubscription.findUnique({ where: { id: renewal.subscriptionId }, select: { buyerId: true } });
    if (sub) {
      await notifyBuyer(
        sub.buyerId,
        renewal.subscriptionId,
        "admin_retry_payment",
        "We retried your Foodstuffs Subscription payment",
        result?.status === "ORDER_CREATED" ? "The payment went through and your order is being prepared." : "Eki support retried your payment. Check the app for the result or update your payment method.",
      );
    }
    return result;
  },
};

async function requireSub(id: string) {
  const sub = await prisma.buyerSubscription.findUnique({ where: { id } });
  if (!sub) throw new AppError("Subscription not found", 404);
  return sub;
}

function snapshot(s: { status: string; frequency: string; nextRenewalAt: Date | null; pausedUntil: Date | null; pausedReason: string | null }) {
  return {
    status: s.status,
    frequency: s.frequency,
    nextRenewalAt: s.nextRenewalAt?.toISOString() ?? null,
    pausedUntil: s.pausedUntil?.toISOString() ?? null,
    pausedReason: s.pausedReason,
  };
}

async function audit(
  adminId: string,
  action: string,
  id: string,
  before: Parameters<typeof snapshot>[0],
  after: Parameters<typeof snapshot>[0],
  reason: string,
  request: any,
  metadata?: Record<string, unknown>,
) {
  await recordAudit({ actorId: adminId, action, entityType: "BuyerSubscription", entityId: id, beforeState: snapshot(before), afterState: snapshot(after), reason, metadata, request });
}

async function notifyBuyer(buyerId: string, subscriptionId: string, event: string, title: string, body: string) {
  await notificationsService
    .enqueue({ userId: buyerId, type: "SUBSCRIPTION_UPDATE", title, body, data: { type: "subscription_update", event, subscriptionId, changedByAdmin: true } })
    .catch(() => {
      /* non-blocking */
    });
}

const HISTORY_LABELS: Record<string, string> = {
  created: "Subscription created",
  paused: "Paused by buyer",
  admin_paused: "Paused by admin",
  resumed: "Resumed by buyer",
  admin_resumed: "Resumed by admin",
  auto_resumed: "Resumed automatically (pause ended)",
  skipped_next: "Next delivery skipped by buyer",
  admin_skipped_next: "Next delivery skipped by admin",
  cancelled: "Cancelled by buyer",
  admin_cancelled: "Cancelled by admin",
  edited: "Basket edited",
  frequency_changed: "Frequency changed by buyer",
  admin_frequency_changed: "Frequency changed by admin",
  rescheduled: "Next delivery date changed by buyer",
  admin_rescheduled: "Next delivery date changed by admin",
  payment_method_changed: "Payment method changed",
  paused_payment_failed: "Paused after payment retries were exhausted",
  stock_timeout_skipped: "Cycle skipped: vendor did not confirm stock in time",
};
