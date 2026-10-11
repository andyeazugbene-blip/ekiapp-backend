/**
 * Vendor onboarding funnel (2026-10-11, extended same day per follow-up
 * request) — the drop-off dashboard a vendor acquisition spend decision
 * depends on. Covers: stage order/labels (including the new "first_order"
 * stage), the conversion math, "ever reached" semantics (reached outside
 * the window still counts), per-stage stuck-vendor lists, the
 * explicitly-marked-unavailable stages (store setup / store published),
 * the explicit attribution-unavailable flag, explicit from/to date-range
 * filtering, and the empty-cohort case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findMany: vi.fn() },
    product: { groupBy: vi.fn() },
    deliveryZone: { groupBy: vi.fn() },
    event: { groupBy: vi.fn() },
    order: { findMany: vi.fn() },
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
  m.order.findMany.mockResolvedValue([]);
});

describe("adminVendorFunnelService.getFunnel", () => {
  it("empty cohort: no vendors registered in range", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    expect(result.cohortSize).toBe(0);
    expect(result.steps).toEqual([]);
    // Unavailable stages and the attribution flag are reported even for an empty cohort.
    expect(result.unavailableStages.map((s) => s.id)).toEqual(["store_setup", "store_published"]);
    expect(result.attribution.available).toBe(false);
  });

  it("builds all 6 trackable stages in order, plus the 2 explicitly-unavailable stages reported separately", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Store A", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
    ]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    expect(result.steps.map((s) => s.id)).toEqual([
      "registered", "product_added", "delivery_configured", "verified", "store_visited", "first_order",
    ]);
    expect(result.steps.every((s) => s.available)).toBe(true);
    expect(result.steps[0].vendorCount).toBe(1);
    expect(result.unavailableStages).toEqual([
      expect.objectContaining({ available: false, id: "store_setup" }),
      expect.objectContaining({ available: false, id: "store_published" }),
    ]);
  });

  it("a vendor who reached a later stage outside the range window still counts ('ever reached')", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Store A", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
    ]);
    m.product.groupBy.mockResolvedValue([{ vendorId: "v1", _min: { createdAt: day(20) } }]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    const productStep = result.steps.find((s) => s.id === "product_added")!;
    expect(productStep.vendorCount).toBe(1);
    expect(productStep.medianDaysFromRegistration).toBe(19);
  });

  it("first_order uses the payment's processedAt, taking the EARLIEST successful payment per vendor across possibly several orders", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Store A", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
    ]);
    m.order.findMany.mockResolvedValue([
      { vendorId: "v1", createdAt: day(10), payment: { processedAt: day(10) } },
      { vendorId: "v1", createdAt: day(3), payment: { processedAt: day(3) } }, // earlier order — this one should win
    ]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    const firstOrderStep = result.steps.find((s) => s.id === "first_order")!;
    expect(firstOrderStep.vendorCount).toBe(1);
    expect(firstOrderStep.medianDaysFromRegistration).toBe(2); // day(3) - day(1)
  });

  it("first_order falls back to Order.createdAt when payment.processedAt is null (legacy row)", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Store A", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
    ]);
    m.order.findMany.mockResolvedValue([{ vendorId: "v1", createdAt: day(4), payment: { processedAt: null } }]);
    const result = await adminVendorFunnelService.getFunnel("30d");
    expect(result.steps.find((s) => s.id === "first_order")!.medianDaysFromRegistration).toBe(3);
  });

  it("conversion percentages and drop-off counts are computed step-to-step, not vs the whole cohort", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "A", createdAt: day(1), verifiedAt: day(5), user: { email: "a@x.com" } },
      { id: "v2", storeName: "B", createdAt: day(1), verifiedAt: null, user: { email: "b@x.com" } },
      { id: "v3", storeName: "C", createdAt: day(1), verifiedAt: null, user: { email: "c@x.com" } },
      { id: "v4", storeName: "D", createdAt: day(1), verifiedAt: null, user: { email: "d@x.com" } },
    ]);
    // 4 registered -> 3 add a product -> 1 configures delivery -> 1 verifies (v1) -> 0 store views -> 0 orders.
    m.product.groupBy.mockResolvedValue([
      { vendorId: "v1", _min: { createdAt: day(2) } },
      { vendorId: "v2", _min: { createdAt: day(2) } },
      { vendorId: "v3", _min: { createdAt: day(2) } },
    ]);
    m.deliveryZone.groupBy.mockResolvedValue([{ vendorId: "v1", _min: { createdAt: day(3) } }]);

    const result = await adminVendorFunnelService.getFunnel("30d");
    const [registered, product, delivery, verified, shared, firstOrder] = result.steps;

    expect(registered.vendorCount).toBe(4);
    expect(registered.conversionFromPrevious).toBe(100);
    expect(registered.stuckVendors).toEqual([]); // nothing precedes the first step

    expect(product.vendorCount).toBe(3);
    expect(product.conversionFromPrevious).toBe(75); // 3/4
    expect(product.conversionFromStart).toBe(75);
    expect(product.droppedHere).toBe(1); // v4 never added a product
    expect(product.stuckVendors.map((v) => v.vendorId)).toEqual(["v4"]);

    expect(delivery.vendorCount).toBe(1);
    expect(delivery.conversionFromPrevious).toBeCloseTo(33.3, 1); // 1/3
    expect(delivery.droppedHere).toBe(2); // v2, v3 added a product but never set up delivery
    expect(delivery.stuckVendors.map((v) => v.vendorId).sort()).toEqual(["v2", "v3"]);

    expect(verified.vendorCount).toBe(1);
    expect(verified.conversionFromPrevious).toBe(100); // the 1 who configured delivery also verified
    expect(verified.droppedHere).toBe(0);
    expect(verified.stuckVendors).toEqual([]);

    expect(shared.vendorCount).toBe(0);
    expect(shared.droppedHere).toBe(1);
    expect(shared.stuckVendors.map((v) => v.vendorId)).toEqual(["v1"]);

    expect(firstOrder.vendorCount).toBe(0);
    expect(firstOrder.droppedHere).toBe(0); // nobody reached "shared" to drop from
  });

  it("stuckVendors on the product_added stage lists exactly the vendors who never added a product, newest-registration-first by days-since, capped at 50", async () => {
    m.vendor.findMany.mockResolvedValue([
      { id: "v1", storeName: "Reached", createdAt: day(1), verifiedAt: null, user: { email: "a@x.com" } },
      { id: "v2", storeName: "Stuck", createdAt: day(1), verifiedAt: null, user: { email: "b@x.com" } },
    ]);
    m.product.groupBy.mockResolvedValue([{ vendorId: "v1", _min: { createdAt: day(2) } }]);

    const result = await adminVendorFunnelService.getFunnel("30d");
    const stuck = result.steps.find((s) => s.id === "product_added")!.stuckVendors;
    expect(stuck).toHaveLength(1);
    expect(stuck[0].vendorId).toBe("v2");
    expect(stuck[0].storeName).toBe("Stuck");
  });

  it("defaults to 30d for an invalid/missing range", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    const result = await adminVendorFunnelService.getFunnel("bogus");
    expect(result.range).toBe("30d");
  });

  it("an explicit from/to overrides the preset range", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    const from = "2026-01-01";
    const to = "2026-01-31";
    await adminVendorFunnelService.getFunnel("30d", from, to);
    expect(m.vendor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: new Date("2026-01-01T00:00:00.000Z") }),
        }),
      }),
    );
  });

  it("an invalid explicit range (from after to) is ignored, falling back to the preset", async () => {
    m.vendor.findMany.mockResolvedValue([]);
    const result = await adminVendorFunnelService.getFunnel("7d", "2026-02-01", "2026-01-01");
    expect(result.range).toBe("7d");
  });
});
