/**
 * Handoff M-06 "membership.capabilities.paused". Notification-only; the
 * grace length comes from the admin-configurable MEMBERSHIP_GRACE_PERIOD_DAYS
 * setting, never a hardcoded number.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendorSubscription: { findMany: vi.fn() },
    vendor: { findMany: vi.fn() },
  },
}));

const mockGetValue = vi.fn();
vi.mock("../modules/admin/admin-platform-settings.service", () => ({
  adminPlatformSettingsService: { getValue: (...a: unknown[]) => mockGetValue(...a) },
}));

const mockSend = vi.fn().mockResolvedValue({ outcome: "SENT" });
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: (...a: unknown[]) => mockSend(...a) },
}));

import { prisma } from "../lib/prisma";
import { membershipGraceService } from "../modules/subscriptions/membership-grace.service";

const m = vi.mocked(prisma, true) as any;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ outcome: "SENT" });
});

describe("membershipGraceService.runCapabilitiesPausedSweep", () => {
  it("never guesses a grace length — does nothing when the setting isn't configured yet", async () => {
    mockGetValue.mockResolvedValue(null);
    const result = await membershipGraceService.runCapabilitiesPausedSweep();
    expect(result.notified).toBe(0);
    expect(m.vendorSubscription.findMany).not.toHaveBeenCalled();
  });

  it("notifies a vendor whose subscription has been PAST_DUE longer than the configured grace period", async () => {
    mockGetValue.mockResolvedValue(7);
    m.vendorSubscription.findMany.mockResolvedValue([
      { id: "sub-1", vendorId: "vendor-1", updatedAt: new Date(Date.now() - 8 * DAY_MS) },
    ]);
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "user-1", storeName: "Mama Eki", contactEmail: "a@x.com" }]);

    const result = await membershipGraceService.runCapabilitiesPausedSweep();

    expect(result.notified).toBe(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_membership_capabilities_paused",
      recipientId: "user-1",
    }));
  });

  it("uses the admin-configured grace length as the cutoff, not a hardcoded one", async () => {
    mockGetValue.mockResolvedValue(3);
    m.vendorSubscription.findMany.mockResolvedValue([]);
    await membershipGraceService.runCapabilitiesPausedSweep();
    expect(m.vendorSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "PAST_DUE",
        updatedAt: { lt: expect.any(Date) },
      }),
    }));
    const cutoff = m.vendorSubscription.findMany.mock.calls[0][0].where.updatedAt.lt as Date;
    const expectedCutoff = Date.now() - 3 * DAY_MS;
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(5000);
  });

  it("the dedupeKey is scoped to the specific PAST_DUE episode (via updatedAt), not just the subscription id", async () => {
    mockGetValue.mockResolvedValue(7);
    const updatedAt = new Date(Date.now() - 10 * DAY_MS);
    m.vendorSubscription.findMany.mockResolvedValue([{ id: "sub-1", vendorId: "vendor-1", updatedAt }]);
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "user-1", storeName: "Mama Eki", contactEmail: null }]);

    await membershipGraceService.runCapabilitiesPausedSweep();

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `MEMBERSHIP_PAUSED:sub-1:${updatedAt.toISOString()}`,
    }));
  });

  it("skips a subscription whose vendor can't be resolved (defensive)", async () => {
    mockGetValue.mockResolvedValue(7);
    m.vendorSubscription.findMany.mockResolvedValue([{ id: "sub-1", vendorId: "vendor-ghost", updatedAt: new Date(Date.now() - 10 * DAY_MS) }]);
    m.vendor.findMany.mockResolvedValue([]);

    const result = await membershipGraceService.runCapabilitiesPausedSweep();

    expect(result.notified).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
