/**
 * Handoff V-05 "store.ready" (Eki Notification & Automation Engine,
 * 12 Oct 2026): fires once, the first moment a vendor has both an active
 * product and a delivery zone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    product: { count: vi.fn() },
    deliveryZone: { count: vi.fn() },
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
