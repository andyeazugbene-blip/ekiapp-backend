/**
 * Eki Notification & Automation Engine handoff (12 Oct 2026):
 *  - O-02 "order.unacknowledged": "15 business-minutes; at configured SLA;
 *    Still unaccepted -> Accepted/cancelled."
 *  - O-04 "order.dispatch.due": "2 business-hours before due; at breach;
 *    Not dispatched -> Dispatched/cancelled."
 *
 * Both are implemented here with PLAIN ELAPSED TIME, not a real
 * business-hours calendar -- the handoff explicitly lists "business-hours
 * SLA" as an owner sign-off item (see docs/NOTIFICATION_ENGINE_GAP_ANALYSIS
 * _AND_PLAN.md §11); building a real business-hours engine without that
 * decision would mean guessing a calendar nobody approved. Using the
 * handoff's own stated default timings as plain elapsed-time thresholds is
 * the safe middle ground: strictly more reminders than a business-hours
 * version would send (never silently late), configurable, and documented
 * here as a deliberate simplification rather than a hidden assumption.
 *
 * O-04 also has no `dispatchDueAt` column on Order -- this computes a due
 * time on the fly (vendorConfirmedAt + DISPATCH_DUE_HOURS) rather than
 * adding one, since nothing else needs to persist it.
 */
import type { Order } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** O-02's handoff-stated first-reminder default. */
const UNACKNOWLEDGED_FIRST_REMINDER_MINUTES = 15;
/** O-02's "configured SLA" escalation — reuses the EXISTING admin action-centre threshold (admin-action-centre.service.ts ACTION_CENTRE_THRESHOLDS.pendingAcceptanceHours) so the vendor's final nudge and the admin's own overdue view agree on one number instead of drifting apart. */
const UNACKNOWLEDGED_ESCALATION_HOURS = 24;
/** O-04: no real due-date column exists; this is the assumed accept-to-dispatch window the "2 business-hours before due" reminder counts down from. */
const DISPATCH_DUE_HOURS = 24;
const DISPATCH_DUE_REMINDER_HOURS_BEFORE = 2;

const UNACKNOWLEDGED_STATUSES = ["PAID", "PAYMENT_SECURED"] as const;
const AWAITING_DISPATCH_STATUSES = ["CONFIRMED", "VENDOR_CONFIRMED", "PROCESSING"] as const;

/** Order has no `vendor` relation declared (plain vendorId FK only, same as everywhere else in this codebase that joins it) — one batched lookup rather than N+1 per-order queries. */
async function loadVendors(vendorIds: string[]): Promise<Map<string, { userId: string; storeName: string }>> {
  if (vendorIds.length === 0) return new Map();
  const vendors = await prisma.vendor.findMany({ where: { id: { in: [...new Set(vendorIds)] } }, select: { id: true, userId: true, storeName: true } });
  return new Map(vendors.map((v) => [v.id, { userId: v.userId, storeName: v.storeName }]));
}

async function sendOrderPush(vendorUserId: string, eventKey: "vendor_order_unacknowledged" | "vendor_order_dispatch_due", order: Pick<Order, "id" | "orderNumber">, dedupeSuffix: string, variables: Record<string, string>): Promise<boolean> {
  try {
    const result = await communicationService.send({
      eventKey,
      recipientId: vendorUserId,
      variables,
      dedupeKey: `${eventKey.toUpperCase()}:${order.id}:${dedupeSuffix}`,
      data: { type: "order_status", orderId: order.id, orderNumber: order.orderNumber },
    });
    return result.outcome === "SENT";
  } catch (error) {
    logger.warn(`${eventKey} send failed`, { orderId: order.id, errorMessage: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export const orderAcceptanceNotificationsService = {
  /** O-02: reminds a vendor about a paid order they haven't accepted yet, then escalates once. */
  async runUnacknowledgedOrderSweep(): Promise<{ firstReminders: number; escalations: number }> {
    const firstCutoff = new Date(Date.now() - UNACKNOWLEDGED_FIRST_REMINDER_MINUTES * MINUTE_MS);
    const escalationCutoff = new Date(Date.now() - UNACKNOWLEDGED_ESCALATION_HOURS * HOUR_MS);

    const orders = await prisma.order.findMany({
      where: { status: { in: [...UNACKNOWLEDGED_STATUSES] }, vendorConfirmedAt: null, createdAt: { lt: firstCutoff }, vendorId: { not: null } },
      select: { id: true, orderNumber: true, createdAt: true, vendorId: true },
      take: 500,
    });
    const vendorsById = await loadVendors(orders.map((o) => o.vendorId).filter((id): id is string => Boolean(id)));

    let firstReminders = 0;
    let escalations = 0;
    for (const order of orders) {
      const vendor = order.vendorId ? vendorsById.get(order.vendorId) : undefined;
      if (!vendor) continue;
      const vars = { store_name: vendor.storeName ?? "Your store", order_number: order.orderNumber };
      const sentFirst = await sendOrderPush(vendor.userId, "vendor_order_unacknowledged", order, "first", vars);
      if (sentFirst) firstReminders++;

      if (order.createdAt < escalationCutoff) {
        const sentEscalation = await sendOrderPush(vendor.userId, "vendor_order_unacknowledged", order, "escalation", vars);
        if (sentEscalation) escalations++;
      }
    }
    return { firstReminders, escalations };
  },

  /** O-04: reminds a vendor whose accepted order is approaching (or past) its assumed dispatch window. */
  async runDispatchDueSweep(): Promise<{ reminders: number; breaches: number }> {
    const reminderFrom = new Date(Date.now() - (DISPATCH_DUE_HOURS - DISPATCH_DUE_REMINDER_HOURS_BEFORE) * HOUR_MS);

    const orders = await prisma.order.findMany({
      where: { status: { in: [...AWAITING_DISPATCH_STATUSES] }, vendorConfirmedAt: { not: null, lt: reminderFrom }, vendorId: { not: null } },
      select: { id: true, orderNumber: true, vendorConfirmedAt: true, vendorId: true },
      take: 500,
    });
    const vendorsById = await loadVendors(orders.map((o) => o.vendorId).filter((id): id is string => Boolean(id)));

    let reminders = 0;
    let breaches = 0;
    for (const order of orders) {
      const vendor = order.vendorId ? vendorsById.get(order.vendorId) : undefined;
      if (!vendor || !order.vendorConfirmedAt) continue;
      const dueAt = new Date(order.vendorConfirmedAt.getTime() + DISPATCH_DUE_HOURS * HOUR_MS);
      const breached = Date.now() > dueAt.getTime();
      const vars = { store_name: vendor.storeName ?? "Your store", order_number: order.orderNumber };

      const sentReminder = await sendOrderPush(vendor.userId, "vendor_order_dispatch_due", order, "reminder", vars);
      if (sentReminder) reminders++;

      if (breached) {
        const sentBreach = await sendOrderPush(vendor.userId, "vendor_order_dispatch_due", order, "breach", vars);
        if (sentBreach) breaches++;
      }
    }
    return { reminders, breaches };
  },
};
