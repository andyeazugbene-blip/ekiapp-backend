import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    cart: { findMany: vi.fn() },
    vendor: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    product: { findMany: vi.fn(), groupBy: vi.fn().mockResolvedValue([]) },
    deliveryZone: { groupBy: vi.fn().mockResolvedValue([]) },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    orderItem: { findFirst: vi.fn().mockResolvedValue(null) },
    event: { count: vi.fn().mockResolvedValue(0) },
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

describe("automationDetectors.runSweep — CART_RECOVERY (per-vendor reminder delay; bounded two-touch schedule, fixed 2026-10-22)", () => {
  function cartItem(overrides: Partial<{ id: string; ageHours: number; vendorId: string; isActive: boolean; stock: number }> = {}) {
    return {
      id: overrides.id ?? "item-a",
      createdAt: new Date(NOW.getTime() - (overrides.ageHours ?? 5) * 60 * 60 * 1000),
      product: { vendorId: overrides.vendorId ?? "vendor-a", isActive: overrides.isActive ?? true, stock: overrides.stock ?? 10 },
    };
  }

  it("schedules once per vendor represented in a multi-vendor cart, each against its own configured delay", async () => {
    const staleItem = cartItem({ id: "item-a", ageHours: 5, vendorId: "vendor-a" }); // 5h old
    const freshItem = cartItem({ id: "item-b", ageHours: 1.5, vendorId: "vendor-b" }); // 1.5h old
    m.cart.findMany.mockResolvedValue([{ id: "cart-1", buyerId: "buyer-1", items: [staleItem, freshItem] }] as never);
    mockGetVendorAutomationConfig.mockImplementation(async (_vendorId: string, type: string) => {
      if (type !== "CART_RECOVERY") throw new Error("unexpected type");
      return { reminderHours: 2, secondReminderHours: 24 }; // default for both vendors in this test
    });

    const results = await automationDetectors.runSweep();

    // vendor-a's item is 5h old (past the 2h default, under the 24h second
    // delay -> "first" touch) — scheduled. vendor-b's item is 1.5h old
    // (under the 2h default) — not scheduled.
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CART_RECOVERY", vendorId: "vendor-a", recipientUserId: "buyer-1", subjectKey: "cart-1:vendor-a:first" }),
    );
    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CART_RECOVERY", vendorId: "vendor-b" }),
    );
    expect(results.CART_RECOVERY).toBe(1);
  });

  it("honors a vendor's own longer reminder delay — a 3h-old item is not yet due at a 24h setting", async () => {
    const item = cartItem({ id: "item-c", ageHours: 3, vendorId: "vendor-c" });
    m.cart.findMany.mockResolvedValue([{ id: "cart-2", buyerId: "buyer-2", items: [item] }] as never);
    mockGetVendorAutomationConfig.mockResolvedValue({ reminderHours: 24, secondReminderHours: 48 });

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CART_RECOVERY" }));
  });

  it("at/past the configured secondReminderHours, sends the FINAL touch, not a repeat of the first", async () => {
    const item = cartItem({ id: "item-d", ageHours: 30, vendorId: "vendor-d" }); // past the 24h second delay
    m.cart.findMany.mockResolvedValue([{ id: "cart-3", buyerId: "buyer-3", items: [item] }] as never);
    mockGetVendorAutomationConfig.mockResolvedValue({ reminderHours: 2, secondReminderHours: 24 });

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CART_RECOVERY", subjectKey: "cart-3:vendor-d:final", title: expect.stringContaining("Last chance") }),
    );
  });

  it("no longer sets frequencyCapDays — a buyer with stale carts at TWO different vendors gets a reminder for BOTH, not just whichever ran first (the bug: a flat per-recipient cap wrongly suppressed the second vendor)", async () => {
    const itemVendorA = cartItem({ id: "item-e", ageHours: 5, vendorId: "vendor-e" });
    const itemVendorB = cartItem({ id: "item-f", ageHours: 5, vendorId: "vendor-f" });
    m.cart.findMany.mockResolvedValue([{ id: "cart-4", buyerId: "buyer-4", items: [itemVendorA, itemVendorB] }] as never);
    mockGetVendorAutomationConfig.mockResolvedValue({ reminderHours: 2, secondReminderHours: 24 });

    await automationDetectors.runSweep();

    const cartRecoveryCalls = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "CART_RECOVERY");
    expect(cartRecoveryCalls.every(([a]: any[]) => a.frequencyCapDays === undefined)).toBe(true);
    expect(cartRecoveryCalls).toHaveLength(2);
    expect(cartRecoveryCalls.map(([a]: any[]) => a.vendorId).sort()).toEqual(["vendor-e", "vendor-f"]);
  });

  it("skips the reminder entirely when every item for that vendor is now unavailable (out of stock or deactivated) — recheck before nudging someone to check out", async () => {
    const outOfStock = cartItem({ id: "item-g", ageHours: 5, vendorId: "vendor-g", stock: 0 });
    m.cart.findMany.mockResolvedValue([{ id: "cart-5", buyerId: "buyer-5", items: [outOfStock] }] as never);
    mockGetVendorAutomationConfig.mockResolvedValue({ reminderHours: 2, secondReminderHours: 24 });

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CART_RECOVERY" }));
  });

  it("still recovers the cart when at least one item for that vendor remains purchasable, even if another is now unavailable", async () => {
    const unavailable = cartItem({ id: "item-h", ageHours: 5, vendorId: "vendor-h", isActive: false });
    const available = cartItem({ id: "item-i", ageHours: 5, vendorId: "vendor-h" });
    m.cart.findMany.mockResolvedValue([{ id: "cart-6", buyerId: "buyer-6", items: [unavailable, available] }] as never);
    mockGetVendorAutomationConfig.mockResolvedValue({ reminderHours: 2, secondReminderHours: 24 });

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(expect.objectContaining({ type: "CART_RECOVERY", vendorId: "vendor-h" }));
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

describe("automationDetectors.runSweep — REGISTRATION_REMINDER (spec R01, 2026-10-25: nudges a VENDOR who never created their Vendor profile, on the spec's 4h/24h/72h P2 cadence — not email verification, which has no reachable UI in this codebase)", () => {
  function user(overrides: Partial<{ id: string; createdAt: Date }> = {}) {
    return {
      id: overrides.id ?? "user-1",
      createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 4 * 60 * 60 * 1000),
    };
  }

  it("at 4h since signup: the first touch fires", async () => {
    m.user.findMany.mockResolvedValue([user({ createdAt: new Date(NOW.getTime() - 4 * 60 * 60 * 1000) })] as never);
    await automationDetectors.runSweep();
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "REGISTRATION_REMINDER", recipientUserId: "user-1", subjectKey: "user-1:touch1", data: expect.objectContaining({ touch_number: 1 }) }),
    );
  });

  it("at 30h since signup (past the 24h threshold too): both touch1 AND touch2 are attempted in the same sweep — each is its own dedupe key, so a daily cron that only samples once doesn't skip a threshold it's already past", async () => {
    m.user.findMany.mockResolvedValue([user({ createdAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1000) })] as never);
    await automationDetectors.runSweep();
    const calls = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "REGISTRATION_REMINDER").map(([a]: any[]) => a.subjectKey);
    expect(calls).toEqual(["user-1:touch1", "user-1:touch2"]);
  });

  it("under 4h since signup gets no reminder at all", async () => {
    m.user.findMany.mockResolvedValue([user({ createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) })] as never);
    await automationDetectors.runSweep();
    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "REGISTRATION_REMINDER" }));
  });

  it("past 72h, exactly three touches have been attempted and no fourth is ever generated — the spec's 'maximum three sends per unresolved episode'", async () => {
    m.user.findMany.mockResolvedValue([user({ createdAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000) })] as never);
    await automationDetectors.runSweep();
    const calls = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "REGISTRATION_REMINDER").map(([a]: any[]) => a.subjectKey);
    expect(calls).toEqual(["user-1:touch1", "user-1:touch2", "user-1:touch3"]);
  });

  it("the candidate query itself excludes vendors who already have a Vendor profile, plus suspended/test accounts, and never targets buyers — self-cancelling, no separate 'cancel reminder' step needed", async () => {
    m.user.findMany.mockResolvedValue([] as never);
    await automationDetectors.runSweep();
    expect(m.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: "VENDOR", vendor: null, isSuspended: false, isTest: false }),
      }),
    );
  });
});

describe("automationDetectors.runSweep — REORDER_REMINDER (vendor-configurable window + full active/paid exclusion set, fixed 2026-10-22)", () => {
  function deliveredOrder(overrides: Partial<{ id: string; vendorId: string; buyerId: string; daysAgo: number; productId: string; title: string; isActive: boolean; stock: number }> = {}) {
    return {
      id: overrides.id ?? "order-1",
      orderNumber: "ORD-1",
      buyerId: overrides.buyerId ?? "buyer-1",
      vendorId: overrides.vendorId ?? "vendor-1",
      deliveredAt: new Date(NOW.getTime() - (overrides.daysAgo ?? 5) * 24 * 60 * 60 * 1000),
      items: [{
        productId: overrides.productId ?? "product-1",
        product: { title: overrides.title ?? "Rice 5kg", isActive: overrides.isActive ?? true, stock: overrides.stock ?? 10 },
      }],
    };
  }

  beforeEach(() => {
    mockGetVendorAutomationConfig.mockResolvedValue({ reorderWindowDays: 14 });
    // vi.clearAllMocks() (the outer beforeEach) clears call history but does
    // NOT revert a mockResolvedValue a previous test set — reset the
    // "already reordered" lookup to its default here so one test's override
    // can't silently leak into the next.
    m.orderItem.findFirst.mockResolvedValue(null as never);
  });

  it("schedules a reminder for a delivered order inside the vendor's reorder window, with no prior repurchase", async () => {
    m.order.findMany.mockResolvedValue([deliveredOrder({ daysAgo: 5 })] as never);
    m.orderItem.findFirst.mockResolvedValue(null as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "REORDER_REMINDER", recipientUserId: "buyer-1", vendorId: "vendor-1", subjectKey: "order-1:product-1" }),
    );
  });

  it("skips a product that is now inactive or out of stock — availability rechecked at send time, not assumed from the order", async () => {
    m.order.findMany.mockResolvedValue([deliveredOrder({ daysAgo: 5, stock: 0 })] as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "REORDER_REMINDER" }));
  });

  it("skips when the buyer already has a LATER order for this exact product in any active/paid status — not just a completed repurchase (the bug: PROCESSING/DISPATCHED/IN_TRANSIT etc. used to still get a redundant nudge)", async () => {
    m.order.findMany.mockResolvedValue([deliveredOrder({ daysAgo: 5 })] as never);
    m.orderItem.findFirst.mockResolvedValue({ id: "already-in-flight" } as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "REORDER_REMINDER" }));
    expect(m.orderItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: expect.objectContaining({
            status: expect.objectContaining({ in: expect.arrayContaining(["PROCESSING", "DISPATCHED", "IN_TRANSIT", "PAYMENT_SECURED", "VENDOR_CONFIRMED", "DISPUTED"]) }),
          }),
        }),
      }),
    );
  });

  it("respects a vendor's own shorter configured reorder window — an order outside it gets no reminder", async () => {
    mockGetVendorAutomationConfig.mockResolvedValue({ reorderWindowDays: 3 });
    m.order.findMany.mockResolvedValue([deliveredOrder({ daysAgo: 5 })] as never); // 5 days ago, window is 3

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "REORDER_REMINDER" }));
  });

  it("honors a vendor's own longer configured reorder window — an order still inside it (past the old fixed 14-day default) gets a reminder", async () => {
    mockGetVendorAutomationConfig.mockResolvedValue({ reorderWindowDays: 30 });
    m.order.findMany.mockResolvedValue([deliveredOrder({ daysAgo: 20 })] as never); // 20 days ago, window is 30

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(expect.objectContaining({ type: "REORDER_REMINDER" }));
  });

  it("dedupe key is per order+product, so re-running the sweep for the same order never produces a second distinct key", async () => {
    m.order.findMany.mockResolvedValue([deliveredOrder({ daysAgo: 5 })] as never);

    await automationDetectors.runSweep();
    const firstKey = mockScheduleAutomation.mock.calls.find(([a]: any[]) => a.type === "REORDER_REMINDER")?.[0].subjectKey;
    mockScheduleAutomation.mockClear();

    await automationDetectors.runSweep();
    const secondKey = mockScheduleAutomation.mock.calls.find(([a]: any[]) => a.type === "REORDER_REMINDER")?.[0].subjectKey;

    expect(firstKey).toBe(secondKey);
  });
});

describe("automationDetectors.runSweep — vendor onboarding progress rules (Notification Orchestration Spec v2, 2026-10-25: FIRST_SALE's old merged stage-switching copy split into R03/R05/R06/R11, each its own type on the 4h/24h/72h P2 cadence)", () => {
  function candidate(overrides: Partial<{ id: string; userId: string; storeName: string; verificationStatus: string; products: number; hasZone: boolean; createdAt: Date }> = {}) {
    return {
      id: overrides.id ?? "vendor-1",
      userId: overrides.userId ?? "vendor-1-user",
      storeName: overrides.storeName ?? "Mama Eki",
      verificationStatus: overrides.verificationStatus ?? "VERIFIED",
      // Default: store created exactly 4h before NOW, so the first touch is
      // due "today" for every pre-existing test unless a test overrides it.
      createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 4 * 60 * 60 * 1000),
      _count: { products: overrides.products ?? 1 },
      hasZone: overrides.hasZone ?? true,
    };
  }
  function mockCandidates(...candidates: ReturnType<typeof candidate>[]) {
    m.vendor.findMany.mockResolvedValue(candidates as never);
    m.deliveryZone.groupBy.mockResolvedValue(
      candidates.filter((c) => c.hasZone).map((c) => ({ vendorId: c.id, _count: { _all: 1 } })) as never,
    );
  }

  it("R03 FIRST_PRODUCT_REMINDER: a vendor with no active product yet is nudged to add one — not DELIVERY_SETUP_REMINDER/VERIFICATION_REMINDER/FIRST_SALE", async () => {
    mockCandidates(candidate({ products: 0 }));
    await automationDetectors.runSweep();
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FIRST_PRODUCT_REMINDER", vendorId: "vendor-1", title: "Add your first foodstuff" }),
    );
    for (const other of ["DELIVERY_SETUP_REMINDER", "VERIFICATION_REMINDER", "FIRST_SALE"]) {
      expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: other }));
    }
  });

  it("R05 DELIVERY_SETUP_REMINDER: a vendor with a product but no delivery zone is nudged to set up delivery, not FIRST_PRODUCT_REMINDER", async () => {
    mockCandidates(candidate({ products: 1, hasZone: false }));
    await automationDetectors.runSweep();
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "DELIVERY_SETUP_REMINDER", title: "Set up how buyers receive your foodstuff" }),
    );
    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "FIRST_PRODUCT_REMINDER" }));
  });

  it("R06 VERIFICATION_REMINDER: a vendor with product + delivery but not verified is nudged to verify", async () => {
    mockCandidates(candidate({ products: 1, hasZone: true, verificationStatus: "PENDING" }));
    await automationDetectors.runSweep();
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "VERIFICATION_REMINDER", title: "Your store is close to opening" }),
    );
  });

  it("R11 FIRST_SALE: a fully set-up, verified vendor gets the first-sale-campaign nudge, not any of the onboarding-step reminders", async () => {
    mockCandidates(candidate({ products: 1, hasZone: true, verificationStatus: "VERIFIED" }));
    await automationDetectors.runSweep();
    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FIRST_SALE", title: "Work towards your first order" }),
    );
    for (const other of ["FIRST_PRODUCT_REMINDER", "DELIVERY_SETUP_REMINDER", "VERIFICATION_REMINDER"]) {
      expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: other }));
    }
  });

  it("no frequencyCapDays on any of the four — each touch's own dedupeKey is the only de-dupe (the bug that silenced a vendor for days)", async () => {
    mockCandidates(candidate({ products: 0 }));
    await automationDetectors.runSweep();
    const [[call]] = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "FIRST_PRODUCT_REMINDER");
    expect(call.frequencyCapDays).toBeUndefined();
  });

  it("under 4h since store creation: no onboarding-progress nudge fires at all", async () => {
    mockCandidates(candidate({ products: 0, createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }));
    await automationDetectors.runSweep();
    for (const type of ["FIRST_PRODUCT_REMINDER", "DELIVERY_SETUP_REMINDER", "VERIFICATION_REMINDER", "FIRST_SALE"]) {
      expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type }));
    }
  });

  it("at 30h (past 24h too): both touch1 and touch2 fire with distinct dedupe keys, matching the P2 'attempt every due threshold' design", async () => {
    mockCandidates(candidate({ products: 0, createdAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1000) }));
    await automationDetectors.runSweep();
    const keys = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "FIRST_PRODUCT_REMINDER").map(([a]: any[]) => a.subjectKey);
    expect(keys).toEqual(["vendor-1:touch1", "vendor-1:touch2"]);
  });

  it("past 72h, exactly three touches total — never a fourth, matching the spec's 'maximum three sends per unresolved episode'", async () => {
    mockCandidates(candidate({ products: 0, createdAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000) }));
    await automationDetectors.runSweep();
    const keys = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "FIRST_PRODUCT_REMINDER").map(([a]: any[]) => a.subjectKey);
    expect(keys).toEqual(["vendor-1:touch1", "vendor-1:touch2", "vendor-1:touch3"]);
  });
});

describe("automationDetectors.runSweep — STORE_SHARE_REMINDER (spec R10, migrated 2026-10-25, corrected 2026-10-26: real readiness clock + bounded store_viewed fallback)", () => {
  const SHIPPED_AT = new Date("2026-10-26T00:00:00.000Z");

  function readyVendor(overrides: Partial<{ id: string; userId: string; storeName: string }> = {}) {
    return {
      id: overrides.id ?? "vendor-1",
      userId: overrides.userId ?? "vendor-1-user",
      storeName: overrides.storeName ?? "Mama Eki",
    };
  }

  /** Sets up a ready vendor whose product+zone both became real `readySinceHoursAgo` hours before NOW. */
  function mockReady(readySinceHoursAgo: number) {
    const readyAt = new Date(NOW.getTime() - readySinceHoursAgo * 60 * 60 * 1000);
    m.vendor.findMany.mockResolvedValue([readyVendor()] as never);
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _count: { _all: 1 }, _min: { createdAt: readyAt } }] as never);
    m.product.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _min: { createdAt: readyAt } }] as never);
  }

  it("reminds a ready (product + delivery zone) vendor whose store has never been shared or viewed", async () => {
    mockReady(4);
    m.event.count.mockResolvedValue(0 as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "STORE_SHARE_REMINDER", vendorId: "vendor-1", title: "Share your store link" }),
    );
  });

  it("does not remind a vendor whose store has a real store_shared event — the unbounded, spec-intended stop condition", async () => {
    mockReady(4);
    m.event.count.mockImplementation(({ where }: any) => Promise.resolve(where.name === "store_shared" ? 1 : 0) as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "STORE_SHARE_REMINDER" }));
  });

  it("does not remind a vendor viewed BEFORE the 2026-10-26 cutoff (grandfather fallback)", async () => {
    mockReady(4);
    m.event.count.mockImplementation(({ where }: any) => Promise.resolve(where.name === "store_viewed" ? 1 : 0) as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "STORE_SHARE_REMINDER" }));
    expect(m.event.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ name: "store_viewed", createdAt: { lt: SHIPPED_AT } }) }),
    );
  });

  it("DOES remind a vendor whose only store_viewed event is AFTER the cutoff — a post-fix view no longer silently counts as 'shared' (the restriction this compliance review added)", async () => {
    mockReady(4);
    // The mock resolves to 0 regardless of the createdAt filter's actual value — this test's real
    // assertion is that the query sent to the DB scopes store_viewed to createdAt < cutoff at all,
    // proving a post-cutoff view is excluded by construction, not merely "not covered by this test".
    m.event.count.mockResolvedValue(0 as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(expect.objectContaining({ type: "STORE_SHARE_REMINDER" }));
    expect(m.event.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ name: "store_viewed", createdAt: { lt: SHIPPED_AT } }) }),
    );
  });

  it("does not remind a vendor with no delivery zone yet — not actually 'ready'", async () => {
    m.vendor.findMany.mockResolvedValue([readyVendor()] as never);
    m.deliveryZone.groupBy.mockResolvedValue([] as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "STORE_SHARE_REMINDER" }));
    expect(m.event.count).not.toHaveBeenCalled();
  });

  it("still reminds a vendor who already has a paid order — unlike R01/R03/R05/R06/R11, R10's stop condition is 'store shared/viewed', not 'never sold'", async () => {
    // Confirms this detector does NOT reuse loadOnboardingProgressCandidates(),
    // which would wrongly exclude a vendor with a paid order.
    mockReady(4);
    m.event.count.mockResolvedValue(0 as never);

    await automationDetectors.runSweep();

    expect(mockScheduleAutomation).toHaveBeenCalledWith(expect.objectContaining({ type: "STORE_SHARE_REMINDER" }));
    // The query itself has no orderItems/paid-status filter — verified via the mock call args.
    expect(m.vendor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ orderItems: expect.anything() }) }),
    );
  });

  it("cadence clock is the real readiness timestamp (later of first product / first delivery zone), not vendor.createdAt", async () => {
    mockReady(30); // ready 30h ago -> touch1 (4h) and touch2 (24h) both due
    m.event.count.mockResolvedValue(0 as never);

    await automationDetectors.runSweep();

    const keys = mockScheduleAutomation.mock.calls.filter(([a]: any[]) => a.type === "STORE_SHARE_REMINDER").map(([a]: any[]) => a.subjectKey);
    expect(keys).toEqual(["vendor-1:touch1", "vendor-1:touch2"]);
  });

  it("uses whichever of product/delivery-zone became real LAST as the readiness clock — a zone added well after the first product starts the clock later, not earlier", async () => {
    m.vendor.findMany.mockResolvedValue([readyVendor()] as never);
    // Product existed 30h ago, but the delivery zone (the thing that actually completed
    // readiness) was only added 2h ago — the vendor should NOT be measured from 30h.
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _count: { _all: 1 }, _min: { createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) } }] as never);
    m.product.groupBy.mockResolvedValue([{ vendorId: "vendor-1", _min: { createdAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1000) } }] as never);
    m.event.count.mockResolvedValue(0 as never);

    await automationDetectors.runSweep();

    // Only 2h have passed since the LATER (zone) timestamp, under the 4h touch1 threshold.
    expect(mockScheduleAutomation).not.toHaveBeenCalledWith(expect.objectContaining({ type: "STORE_SHARE_REMINDER" }));
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
  it("a vendor eligible for BOTH LOW_STOCK_ALERT and FIRST_PRODUCT_REMINDER in the same sweep is only sent LOW_STOCK_ALERT (it runs first / outranks onboarding)", async () => {
    // Real automationService.scheduleAutomation is mocked out entirely in
    // this file, so this proves the DETECTOR ORDER (the priority rule), not
    // the claim mechanism itself — that's covered against the real service
    // in automation.test.ts's coalescing describe block.
    m.product.findMany.mockResolvedValue([{ id: "p1", vendorId: "vendor-1" }] as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-1-user" } as never);
    m.vendor.findMany.mockResolvedValue([{ id: "vendor-1", userId: "vendor-1-user", storeName: "Mama Eki", verificationStatus: "VERIFIED", createdAt: new Date(NOW.getTime() - 4 * 60 * 60 * 1000), _count: { products: 0 } }] as never);

    await automationDetectors.runSweep();

    const types = mockScheduleAutomation.mock.calls.map(([a]: any[]) => a.type);
    const lowStockIndex = types.indexOf("LOW_STOCK_ALERT");
    const firstProductIndex = types.indexOf("FIRST_PRODUCT_REMINDER");
    expect(lowStockIndex).toBeGreaterThanOrEqual(0);
    expect(firstProductIndex).toBeGreaterThan(lowStockIndex);
  });
});
