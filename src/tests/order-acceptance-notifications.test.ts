import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findMany: vi.fn() },
    vendor: { findMany: vi.fn() },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const mockSend = vi.fn();
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: (...a: unknown[]) => mockSend(...a) },
}));
vi.mock("../modules/admin/admin-platform-settings.service", () => ({
  adminPlatformSettingsService: { getValue: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { adminPlatformSettingsService } from "../modules/admin/admin-platform-settings.service";
import { orderAcceptanceNotificationsService } from "../modules/orders/order-acceptance-notifications.service";

const m = vi.mocked(prisma, true) as any;
const getValue = vi.mocked(adminPlatformSettingsService.getValue);

const NOW = new Date("2026-10-30T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockSend.mockResolvedValue({ outcome: "SENT" });
  m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "vendor-1-user", storeName: "Mama Eki" }]);
});

describe("orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep (O-02/R13) — restored 2026-10-29, admin-configurable", () => {
  it("reminds a vendor about a paid order past the configured first-reminder window, using the admin-set value", async () => {
    getValue.mockImplementation(async (key: string) => (key === "ORDER_UNACKNOWLEDGED_FIRST_REMINDER_MINUTES" ? 15 : key === "ORDER_UNACKNOWLEDGED_ESCALATION_HOURS" ? 24 : null));
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ORD-1", vendorId: "vendor-1", createdAt: new Date(NOW.getTime() - 20 * 60 * 1000) }, // 20 min old
    ]);

    const result = await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();

    expect(result).toEqual({ firstReminders: 1, escalations: 0 });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ eventKey: "vendor_order_unacknowledged", recipientId: "vendor-1-user" }));
  });

  it("falls back to the handoff's own documented defaults (15min/24h) when the setting has never been configured", async () => {
    getValue.mockResolvedValue(null);
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ORD-1", vendorId: "vendor-1", createdAt: new Date(NOW.getTime() - 20 * 60 * 1000) },
    ]);

    const result = await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();

    expect(result.firstReminders).toBe(1);
    expect(m.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ createdAt: { lt: new Date(NOW.getTime() - 15 * 60 * 1000) } }) }),
    );
  });

  it("escalates once an order is past the configured escalation threshold, in addition to the first reminder", async () => {
    getValue.mockImplementation(async (key: string) => (key === "ORDER_UNACKNOWLEDGED_FIRST_REMINDER_MINUTES" ? 15 : key === "ORDER_UNACKNOWLEDGED_ESCALATION_HOURS" ? 24 : null));
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ORD-1", vendorId: "vendor-1", createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) }, // 25h old
    ]);

    const result = await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();

    expect(result).toEqual({ firstReminders: 1, escalations: 1 });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("honors a shorter admin-configured first-reminder window — an order that wouldn't qualify under the default does under the shorter setting", async () => {
    getValue.mockImplementation(async (key: string) => (key === "ORDER_UNACKNOWLEDGED_FIRST_REMINDER_MINUTES" ? 5 : key === "ORDER_UNACKNOWLEDGED_ESCALATION_HOURS" ? 24 : null));
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ORD-1", vendorId: "vendor-1", createdAt: new Date(NOW.getTime() - 10 * 60 * 1000) }, // 10 min old — qualifies at 5min, not the 15min default
    ]);

    const result = await orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep();

    expect(result.firstReminders).toBe(1);
  });
});

describe("orderAcceptanceNotificationsService.runDispatchDueSweep (O-04/R15) — restored 2026-10-29, admin-configurable", () => {
  it("reminds a vendor approaching the configured dispatch window, before breach", async () => {
    getValue.mockImplementation(async (key: string) => (key === "ORDER_DISPATCH_DUE_HOURS" ? 24 : key === "ORDER_DISPATCH_DUE_REMINDER_HOURS_BEFORE" ? 2 : null));
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ORD-1", vendorId: "vendor-1", vendorConfirmedAt: new Date(NOW.getTime() - 23 * 60 * 60 * 1000) }, // confirmed 23h ago, due at 24h -> 1h left, inside the 2h reminder window
    ]);

    const result = await orderAcceptanceNotificationsService.runDispatchDueSweep();

    expect(result).toEqual({ reminders: 1, breaches: 0 });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ eventKey: "vendor_order_dispatch_due", recipientId: "vendor-1-user" }));
  });

  it("sends both the reminder and a breach notice once the configured dispatch deadline has actually passed", async () => {
    getValue.mockImplementation(async (key: string) => (key === "ORDER_DISPATCH_DUE_HOURS" ? 24 : key === "ORDER_DISPATCH_DUE_REMINDER_HOURS_BEFORE" ? 2 : null));
    m.order.findMany.mockResolvedValue([
      { id: "order-1", orderNumber: "ORD-1", vendorId: "vendor-1", vendorConfirmedAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1000) }, // confirmed 30h ago, due at 24h -> breached
    ]);

    const result = await orderAcceptanceNotificationsService.runDispatchDueSweep();

    expect(result).toEqual({ reminders: 1, breaches: 1 });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("falls back to the handoff's own documented defaults (24h/2h) when unconfigured", async () => {
    getValue.mockResolvedValue(null);
    m.order.findMany.mockResolvedValue([]);

    const result = await orderAcceptanceNotificationsService.runDispatchDueSweep();

    expect(result).toEqual({ reminders: 0, breaches: 0 });
    expect(m.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ vendorConfirmedAt: { not: null, lt: new Date(NOW.getTime() - 22 * 60 * 60 * 1000) } }) }),
    );
  });
});
