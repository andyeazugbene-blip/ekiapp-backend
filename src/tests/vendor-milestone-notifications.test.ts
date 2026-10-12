/**
 * Handoff V-05 "store.ready" (Eki Notification & Automation Engine,
 * 12 Oct 2026): fires once, the first moment a vendor has both an active
 * product and a delivery zone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn(), findMany: vi.fn() },
    product: { count: vi.fn() },
    deliveryZone: { count: vi.fn(), groupBy: vi.fn() },
    event: { count: vi.fn() },
  },
}));

const mockSend = vi.fn();
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: (...a: unknown[]) => mockSend(...a) },
}));

import { prisma } from "../lib/prisma";
import { vendorMilestoneNotificationsService } from "../modules/vendors/vendor-milestone-notifications.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.vendor.findUnique.mockResolvedValue({ userId: "user-1", storeName: "Mama Eki", contactEmail: "a@x.com" });
  mockSend.mockResolvedValue({ outcome: "SENT" });
});

describe("vendorMilestoneNotificationsService.maybeSendStoreReady", () => {
  it("sends when the vendor has both >=1 product and >=1 delivery zone", async () => {
    m.product.count.mockResolvedValue(1);
    m.deliveryZone.count.mockResolvedValue(1);

    await vendorMilestoneNotificationsService.maybeSendStoreReady("vendor-1");

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_store_ready",
      recipientId: "user-1",
      dedupeKey: "STORE_READY:vendor-1",
    }));
  });

  it("does not send when there is no product yet", async () => {
    m.product.count.mockResolvedValue(0);
    m.deliveryZone.count.mockResolvedValue(1);
    await vendorMilestoneNotificationsService.maybeSendStoreReady("vendor-1");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not send when there is no delivery zone yet", async () => {
    m.product.count.mockResolvedValue(1);
    m.deliveryZone.count.mockResolvedValue(0);
    await vendorMilestoneNotificationsService.maybeSendStoreReady("vendor-1");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not send (and does not throw) when the vendor doesn't exist", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    m.product.count.mockResolvedValue(1);
    m.deliveryZone.count.mockResolvedValue(1);
    await expect(vendorMilestoneNotificationsService.maybeSendStoreReady("vendor-x")).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("swallows an error from communicationService.send rather than throwing (never breaks the caller's real write)", async () => {
    m.product.count.mockResolvedValue(1);
    m.deliveryZone.count.mockResolvedValue(1);
    mockSend.mockRejectedValue(new Error("boom"));
    await expect(vendorMilestoneNotificationsService.maybeSendStoreReady("vendor-1")).resolves.toBeUndefined();
  });

  it("the dedupeKey is per-vendor — calling it twice relies on communicationService.send's own dedupe, not re-checked here", async () => {
    m.product.count.mockResolvedValue(1);
    m.deliveryZone.count.mockResolvedValue(1);
    await vendorMilestoneNotificationsService.maybeSendStoreReady("vendor-1");
    await vendorMilestoneNotificationsService.maybeSendStoreReady("vendor-1");
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0].dedupeKey).toBe(mockSend.mock.calls[1][0].dedupeKey);
  });
});

describe("vendorMilestoneNotificationsService.sendWelcome (handoff V-01)", () => {
  it("sends the welcome notification for an existing vendor", async () => {
    await vendorMilestoneNotificationsService.sendWelcome("vendor-1");
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_welcome", recipientId: "user-1", dedupeKey: "VENDOR_WELCOME:vendor-1",
    }));
  });

  it("does nothing (no throw) when the vendor doesn't exist", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(vendorMilestoneNotificationsService.sendWelcome("vendor-x")).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("vendorMilestoneNotificationsService.maybeSendFirstVisit (handoff V-07)", () => {
  it("sends when priorViewCount is 0 (this view is the first ever)", async () => {
    await vendorMilestoneNotificationsService.maybeSendFirstVisit("vendor-1", 0);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_store_first_visit", recipientId: "user-1", dedupeKey: "STORE_FIRST_VISIT:vendor-1",
    }));
  });

  it("does not send when priorViewCount is already > 0 (not the first visit)", async () => {
    await vendorMilestoneNotificationsService.maybeSendFirstVisit("vendor-1", 3);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("vendorMilestoneNotificationsService.runShareReminderSweep (handoff V-06)", () => {
  it("reminds a ready vendor who has never had a store_viewed event", async () => {
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "user-1", storeName: "Mama Eki" }]);
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _count: { _all: 1 } }]);
    m.event.count.mockResolvedValue(0);

    const sent = await vendorMilestoneNotificationsService.runShareReminderSweep();

    expect(sent).toBe(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ eventKey: "vendor_store_not_shared", recipientId: "user-1" }));
  });

  it("does not remind a vendor who has already had at least one view (stop condition)", async () => {
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "user-1", storeName: "Mama Eki" }]);
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _count: { _all: 1 } }]);
    m.event.count.mockResolvedValue(1);

    const sent = await vendorMilestoneNotificationsService.runShareReminderSweep();

    expect(sent).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not remind a vendor with no delivery zone — not actually 'ready' yet", async () => {
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "user-1", storeName: "Mama Eki" }]);
    m.deliveryZone.groupBy.mockResolvedValue([]);

    const sent = await vendorMilestoneNotificationsService.runShareReminderSweep();

    expect(sent).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(m.event.count).not.toHaveBeenCalled();
  });

  it("returns 0 immediately when there are no candidate vendors (no N+1 delivery-zone query)", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    const sent = await vendorMilestoneNotificationsService.runShareReminderSweep();
    expect(sent).toBe(0);
    expect(m.deliveryZone.groupBy).not.toHaveBeenCalled();
  });
});
