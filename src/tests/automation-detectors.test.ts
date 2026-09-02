import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    cart: { findMany: vi.fn() },
    vendor: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

const mockScheduleAutomation = vi.fn();
const mockGetVendorAutomationConfig = vi.fn();
vi.mock("../modules/automation/automation.service", () => ({
  automationService: {
    scheduleAutomation: (...args: unknown[]) => mockScheduleAutomation(...args),
    getVendorAutomationConfig: (...args: unknown[]) => mockGetVendorAutomationConfig(...args),
  },
}));

import { prisma } from "../lib/prisma";
import { automationDetectors } from "../modules/automation/automation.detectors";

const m = vi.mocked(prisma, true);

const NOW = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("automationDetectors.runSweep — CART_RECOVERY (per-vendor reminder delay)", () => {
  it("schedules once per vendor represented in a multi-vendor cart, each against its own configured delay", async () => {
    const staleItem = { id: "item-a", createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000), product: { vendorId: "vendor-a" } }; // 5h old
    const freshItem = { id: "item-b", createdAt: new Date(NOW.getTime() - 1.5 * 60 * 60 * 1000), product: { vendorId: "vendor-b" } }; // 1.5h old
    m.cart.findMany.mockResolvedValue([{ id: "cart-1", buyerId: "buyer-1", items: [staleItem, freshItem] }] as never);
    mockGetVendorAutomationConfig.mockImplementation(async (_vendorId: string, type: string) => {
      if (type !== "CART_RECOVERY") throw new Error("unexpected type");
      return { reminderHours: 2 }; // default for both vendors in this test
    });

    const results = await automationDetectors.runSweep();

    // vendor-a's item is 5h old (past the 2h default) — scheduled.
    // vendor-b's item is 1.5h old (under the 2h default) — not scheduled.
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CART_RECOVERY", vendorId: "vendor-a", recipientUserId: "buyer-1" }),
    );
    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CART_RECOVERY", vendorId: "vendor-b" }),
    );
    expect(results.CART_RECOVERY).toBe(1);
  });

  it("honors a vendor's own longer reminder delay — a 3h-old item is not yet due at a 24h setting", async () => {
    const item = { id: "item-c", createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000), product: { vendorId: "vendor-c" } };
    m.cart.findMany.mockResolvedValue([{ id: "cart-2", buyerId: "buyer-2", items: [item] }] as never);
    mockGetVendorAutomationConfig.mockResolvedValue({ reminderHours: 24 });

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CART_RECOVERY" }));
  });
});

describe("automationDetectors.runSweep — BUYER_WIN_BACK (per-vendor inactivity window)", () => {
  it("scopes eligibility to a vendor's own buyers using that vendor's configured window", async () => {
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-x", userId: "vendor-x-user" }] as never);
    mockGetVendorAutomationConfig.mockImplementation(async (_vendorId: string, type: string) => {
      if (type !== "BUYER_WIN_BACK") throw new Error("unexpected type");
      return { inactivityDays: 60 };
    });
    m.user.findMany.mockResolvedValue([{ id: "buyer-9" }] as never);

    const results = await automationDetectors.runSweep();

    expect(m.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orders: { some: { status: { in: ["PAID", "DELIVERED", "COMPLETED"] }, vendorId: "vendor-x" } },
        }),
      }),
    );
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "BUYER_WIN_BACK", vendorId: "vendor-x", recipientUserId: "buyer-9" }),
    );
    expect(results.BUYER_WIN_BACK).toBe(1);
  });

  it("skips vendors with no sold order items — never scopes a win-back query to any vendor", async () => {
    m.vendor.findMany.mockResolvedValue([] as never);

    await automationDetectors.runSweep();

    const winBackCalls = m.user.findMany.mock.calls.filter(
      ([args]: any[]) => args?.where?.orders?.some?.vendorId !== undefined,
    );
    expect(winBackCalls).toHaveLength(0);
    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "BUYER_WIN_BACK" }));
  });
});
