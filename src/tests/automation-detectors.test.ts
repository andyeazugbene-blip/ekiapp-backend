import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    cart: { findMany: vi.fn() },
    vendor: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    deliveryZone: { groupBy: vi.fn().mockResolvedValue([]) },
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

describe("automationDetectors.runSweep — FIRST_SALE (bug fix 2026-10-11: depends on the vendor's actual next incomplete step)", () => {
  function candidate(overrides: Partial<{ id: string; userId: string; storeName: string; verificationStatus: string; products: number }> = {}) {
    return {
      id: overrides.id ?? "vendor-1",
      userId: overrides.userId ?? "vendor-1-user",
      storeName: overrides.storeName ?? "Mama Eki",
      verificationStatus: overrides.verificationStatus ?? "VERIFIED",
      _count: { products: overrides.products ?? 1 },
    };
  }

  it("a vendor with no active product yet is nudged to add one, not to 'get an order'", async () => {
    m.vendor.findMany.mockResolvedValue([candidate({ products: 0 })] as never);
    m.deliveryZone.groupBy.mockResolvedValue([] as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "FIRST_SALE", vendorId: "vendor-1", title: "Add your first foodstuff",
        data: expect.objectContaining({ onboarding_stage: "add_product" }),
      }),
    );
  });

  it("a vendor with a product but no delivery zone is nudged to set up delivery", async () => {
    m.vendor.findMany.mockResolvedValue([candidate({ products: 1 })] as never);
    m.deliveryZone.groupBy.mockResolvedValue([] as never); // no zones for anyone

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FIRST_SALE", title: "Set up delivery", data: expect.objectContaining({ onboarding_stage: "set_delivery" }) }),
    );
  });

  it("a vendor with product + delivery but not verified is nudged to verify", async () => {
    m.vendor.findMany.mockResolvedValue([candidate({ products: 1, verificationStatus: "PENDING" })] as never);
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _count: { _all: 2 } }] as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FIRST_SALE", title: "Verify your account", data: expect.objectContaining({ onboarding_stage: "verify" }) }),
    );
  });

  it("a fully set-up, verified vendor gets the original 'get your first order' nudge", async () => {
    m.vendor.findMany.mockResolvedValue([candidate({ products: 1, verificationStatus: "VERIFIED" })] as never);
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _count: { _all: 1 } }] as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FIRST_SALE", title: "Get your first order", data: expect.objectContaining({ onboarding_stage: "get_first_order" }) }),
    );
  });

  it("the dedupe subjectKey includes the stage, so moving to a new stage doesn't wait out the old stage's weekly cap", async () => {
    m.vendor.findMany.mockResolvedValue([candidate({ products: 0 })] as never);
    m.deliveryZone.groupBy.mockResolvedValue([] as never);
    await automationDetectors.runSweep();
    const [[firstCall]] = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "FIRST_SALE");
    expect(firstCall.subjectKey).toContain("add_product");
  });
});

describe("automationDetectors.runSweep — LOW_STOCK_ALERT (bug fix 2026-10-11: idempotent and state-based, not a daily repeat)", () => {
  it("the dedupe subjectKey is content-derived (same low-stock set -> same key), not purely date-based", async () => {
    m.product.findMany.mockResolvedValue([{ id: "p1", vendorId: "vendor-1" }, { id: "p2", vendorId: "vendor-1" }] as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-1-user" } as never);

    await automationDetectors.runSweep();

    const [[call]] = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "LOW_STOCK_ALERT");
    expect(call.subjectKey.startsWith("vendor-1:")).toBe(true);
    expect(call.frequencyCapDays).toBeUndefined(); // the content hash + cooldown bucket IS the cap now
  });

  it("a different set of low-stock products produces a different subjectKey (always alerts on a genuine new low-stock item)", async () => {
    m.product.findMany.mockResolvedValue([{ id: "p1", vendorId: "vendor-1" }] as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-1-user" } as never);
    await automationDetectors.runSweep();
    const firstKey = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "LOW_STOCK_ALERT")[0][0].subjectKey;

    mockScheduleAutomation.mockClear();
    m.product.findMany.mockResolvedValue([{ id: "p1", vendorId: "vendor-1" }, { id: "p2", vendorId: "vendor-1" }] as never);
    await automationDetectors.runSweep();
    const secondKey = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "LOW_STOCK_ALERT")[0][0].subjectKey;

    expect(firstKey).not.toBe(secondKey);
  });

  it("the identical low-stock set re-evaluated produces the identical subjectKey within the same cooldown bucket (deduped by the DB-unique key, not re-sent)", async () => {
    m.product.findMany.mockResolvedValue([{ id: "p1", vendorId: "vendor-1" }] as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-1-user" } as never);
    await automationDetectors.runSweep();
    const firstKey = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "LOW_STOCK_ALERT")[0][0].subjectKey;

    mockScheduleAutomation.mockClear();
    await automationDetectors.runSweep(); // same system time, same product set
    const secondKey = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "LOW_STOCK_ALERT")[0][0].subjectKey;

    expect(firstKey).toBe(secondKey);
  });
});

describe("automationDetectors.runSweep — coalescing (bug fix 2026-10-11: no stacking non-urgent notifications)", () => {
  it("a vendor eligible for BOTH LOW_STOCK_ALERT and FIRST_SALE in the same sweep is only sent LOW_STOCK_ALERT (it runs first / outranks onboarding)", async () => {
    // Real automationService.scheduleAutomation is mocked out entirely in
    // this file, so this proves the DETECTOR ORDER (the priority rule), not
    // the claim mechanism itself — that's covered against the real service
    // in automation.test.ts's coalescing describe block.
    m.product.findMany.mockResolvedValue([{ id: "p1", vendorId: "vendor-1" }] as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-1-user" } as never);
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "vendor-1-user", storeName: "Mama Eki", verificationStatus: "VERIFIED", _count: { products: 0 } }] as never);

    await automationDetectors.runSweep();

    const types = mockScheduleAutomation.mock.calls.map(([a]: any[]) => a.type);
    const lowStockIndex = types.indexOf("LOW_STOCK_ALERT");
    const firstSaleIndex = types.indexOf("FIRST_SALE");
    expect(lowStockIndex).toBeGreaterThanOrEqual(0);
    expect(firstSaleIndex).toBeGreaterThan(lowStockIndex);
  });
});
