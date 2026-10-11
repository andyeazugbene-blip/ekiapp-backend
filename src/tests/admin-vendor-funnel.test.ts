/**
 * Vendor onboarding funnel (2026-10-11) — the drop-off dashboard a vendor
 * acquisition spend decision depends on. Covers: step order/labels, the
 * conversion math, "ever reached" semantics (reached outside the window
 * still counts), the stuck-at-registration list, and the empty-cohort case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findMany: vi.fn() },
    product: { groupBy: vi.fn() },
    deliveryZone: { groupBy: vi.fn() },
    event: { groupBy: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminVendorFunnelService } from "../modules/admin/admin-vendor-funnel.service";

const m = vi.mocked(prisma, true) as any;

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

beforeEach(() => {
  vi.clearAllMocks();
  m.product.groupBy.mockResolvedValue([]);
  m.deliveryZone.groupBy.mockResolvedValue([]);
  m.event.groupBy.mockResolvedValue([]);
});

describe("adminVendorFunnelService.getFunnel", () => {
  it("empty cohort: no vendors registered in range", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    expect(result.cohortSize).toBe(0);
    expect(result.steps).toEqual([]);
    expect(result.stuckAtRegistration).toEqual([]);
  });

  it("builds all 5 steps in order with correct labels", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Store A", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
    ]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    expect(result.steps.map((s) => s.id)).toEqual(["registered", "product_added", "delivery_configured", "verified", "store_visited"]);
    expect(result.steps[0].vendorCount).toBe(1);
  });

  it("a vendor who reached a later step outside the range window still counts ('ever reached')", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Store A", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
    ]);
    // Product created well after any 30-day window from "today" in these tests' fixed date.
    m.product.groupBy.mockResolvedValue([{ vendorId: "v1", _min: { createdAt: day(20) } }]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    const productStep = result.steps.find((s) => s.id === "product_added")!;
    expect(productStep.vendorCount).toBe(1);
    expect(productStep.medianDaysFromRegistration).toBe(19);
  });

  it("conversion percentages and drop-off counts are computed step-to-step, not vs the whole cohort", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "A", createdAt: day(1), verifiedAt: day(5), user: { email: "a@x.com" } },
      { id: "v2", storeName: "B", createdAt: day(1), verifiedAt: null, user: { email: "b@x.com" } },
      { id: "v3", storeName: "C", createdAt: day(1), verifiedAt: null, user: { email: "c@x.com" } },
      { id: "v4", storeName: "D", createdAt: day(1), verifiedAt: null, user: { email: "d@x.com" } },
    ]);
    // 4 registered -> 3 add a product -> 1 configures delivery -> 1 verifies (v1) -> 0 store views.
    m.product.groupBy.mockResolvedValue([
      { vendorId: "v1", _min: { createdAt: day(2) } },
      { vendorId: "v2", _min: { createdAt: day(2) } },
      { vendorId: "v3", _min: { createdAt: day(2) } },
    ]);
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "v1", _min: { createdAt: day(3) } }]);

    const result = await adminVendorFunnelService.getFunnel("30d");
    const [registered, product, delivery, verified, shared] = result.steps;

    expect(registered.vendorCount).toBe(4);
    expect(registered.conversionFromPrevious).toBe(100);

    expect(product.vendorCount).toBe(3);
    expect(product.conversionFromPrevious).toBe(75); // 3/4
    expect(product.conversionFromStart).toBe(75);
    expect(product.droppedHere).toBe(1); // v4 never added a product

    expect(delivery.vendorCount).toBe(1);
    expect(delivery.conversionFromPrevious).toBeCloseTo(33.3, 1); // 1/3
    expect(delivery.droppedHere).toBe(2); // v2, v3 added a product but never set up delivery

    expect(verified.vendorCount).toBe(1);
    expect(verified.conversionFromPrevious).toBe(100); // the 1 who configured delivery also verified
    expect(verified.droppedHere).toBe(0);

    expect(shared.vendorCount).toBe(0);
    expect(shared.droppedHere).toBe(1);
  });

  it("stuckAtRegistration lists exactly the vendors who never added a product, newest-registration-first by days-since", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Reached", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
      { id: "v2", storeName: "Stuck", createdAt: day(1), verifiedAt: null, user: { email: "b@x.com" } },
    ]);
    m.product.groupBy.mockResolvedValue([{ vendorId: "v1", _min: { createdAt: day(2) } }]);

    const result = await adminVendorFunnelService.getFunnel("30d");
    expect(result.stuckAtRegistration).toHaveLength(1);
    expect(result.stuckAtRegistration[0].vendorId).toBe("v2");
    expect(result.stuckAtRegistration[0].storeName).toBe("Stuck");
  });

  it("defaults to 30d for an invalid/missing range", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    const result = await adminVendorFunnelService.getFunnel("bogus");
    expect(result.range).toBe("30d");
  });
});
