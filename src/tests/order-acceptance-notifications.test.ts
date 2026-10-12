/**
 * Handoff O-02 "order.unacknowledged" and O-04 "order.dispatch.due"
 * (Eki Notification & Automation Engine, 12 Oct 2026). Elapsed-time
 * defaults, not a real business-hours calendar — see the service file's
 * own doc comment for why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findMany: vi.fn() },
    vendor: { findMany: vi.fn() },
  },
}));

const mockSend = vi.fn().mockResolvedValue({ outcome: "SENT" });
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: (...a: unknown[]) => mockSend(...a) },
}));

import { prisma } from "../lib/prisma";
import { orderAcceptanceNotificationsService } from "../modules/orders/order-acceptance-notifications.service";

const m = vi.mocked(prisma, true) as any;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ outcome: "SENT" });
  m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "user-1", storeName: "Mama Eki" }]);
});

describe("runUnacknowledgedOrderSweep (O-02)", () => {
  it("sends the first reminder for an order paid >15 minutes ago with no vendorConfirmedAt", async () => {
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ON-1", createdAt: new Date(Date.now() - 20 * MINUTE_MS), vendorId: "vendor-1" },
    ]);

    const result = await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();

    expect(result.firstReminders).toBe(1);
    expect(result.escalations).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_order_unacknowledged",
      recipientId: "user-1",
      dedupeKey: "VENDOR_ORDER_UNACKNOWLEDGED:order-1:first",
      data: expect.objectContaining({ type: "order_status", orderId: "order-1" }),
    }));
  });

  it("also fires the escalation reminder for an order older than 24h", async () => {
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ON-1", createdAt: new Date(Date.now() - 25 * HOUR_MS), vendorId: "vendor-1" },
    ]);

    const result = await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();

    expect(result.firstReminders).toBe(1);
    expect(result.escalations).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const keys = mockSend.mock.calls.map((c: any) => c[0].dedupeKey);
    expect(keys).toContain("VENDOR_ORDER_UNACKNOWLEDGED:order-1:first");
    expect(keys).toContain("VENDOR_ORDER_UNACKNOWLEDGED:order-1:escalation");
  });

  it("the query only looks at PAID/PAYMENT_SECURED orders with no vendorConfirmedAt", async () => {
    m.order.findMany.mockResolvedValue([]);
    await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();
    expect(m.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["PAID", "PAYMENT_SECURED"] }, vendorConfirmedAt: null }),
    }));
  });

  it("skips an order whose vendor can't be resolved (defensive, should never happen in practice)", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ON-1", createdAt: new Date(Date.now() - 20 * MINUTE_MS), vendorId: "vendor-ghost" },
    ]);
    const result = await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();
    expect(result.firstReminders).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("runDispatchDueSweep (O-04)", () => {
  it("sends the reminder when within the 2h-before-due window and not yet breached", async () => {
    // Accepted 23h ago; due at 24h -> 1h left, inside the 2h reminder window.
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ON-1", vendorConfirmedAt: new Date(Date.now() - 23 * HOUR_MS), vendorId: "vendor-1" },
    ]);

    const result = await orderAcceptanceNotificationsService.runDispatchDueSweep();

    expect(result.reminders).toBe(1);
    expect(result.breaches).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "VENDOR_ORDER_DISPATCH_DUE:order-1:reminder" }));
  });

  it("sends BOTH the reminder and the breach notice once the due time has passed", async () => {
    // Accepted 30h ago; due at 24h -> already breached by 6h.
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ON-1", vendorConfirmedAt: new Date(Date.now() - 30 * HOUR_MS), vendorId: "vendor-1" },
    ]);

    const result = await orderAcceptanceNotificationsService.runDispatchDueSweep();

    expect(result.reminders).toBe(1);
    expect(result.breaches).toBe(1);
    const keys = mockSend.mock.calls.map((c: any) => c[0].dedupeKey);
    expect(keys).toContain("VENDOR_ORDER_DISPATCH_DUE:order-1:reminder");
    expect(keys).toContain("VENDOR_ORDER_DISPATCH_DUE:order-1:breach");
  });

  it("the query only looks at accepted-but-not-dispatched statuses", async () => {
    m.order.findMany.mockResolvedValue([]);
    await orderAcceptanceNotificationsService.runDispatchDueSweep();
    expect(m.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["CONFIRMED", "VENDOR_CONFIRMED", "PROCESSING"] } }),
    }));
  });
});
