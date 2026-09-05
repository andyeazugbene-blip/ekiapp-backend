/**
 * Multi-vendor delivery eligibility — real device bug: a buyer's address was
 * rejected for the WHOLE cart even when only one vendor in a multi-vendor
 * cart couldn't actually deliver there. A valid vendor must remain valid
 * even when another vendor in the same cart is not (deliveryService.calculate
 * is the buyer-facing pre-check the checkout/cart screens call before ever
 * attempting payment — see payments-vendor-eligibility.test.ts for the
 * backend-authoritative charge-time gate).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    cart: { findUnique: vi.fn() },
    deliveryZone: { findUnique: vi.fn(), findFirst: vi.fn() },
    vendor: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { deliveryService } from "../modules/delivery/delivery.service";

const m = vi.mocked(prisma, true);

function cartWith(items: { vendorId: string; priceInCents: number; currency: string; weightGrams?: number }[]) {
  return {
    id: "c1",
    buyerId: "buyer-1",
    items: items.map((it, i) => ({
      productId: `p${i}`,
      quantity: 1,
      product: { vendorId: it.vendorId, priceInCents: it.priceInCents, currency: it.currency, weightGrams: it.weightGrams ?? 0, title: `Item ${i}` },
    })),
  };
}

const ukGlobalZone = {
  id: "zone-uk-global",
  vendorId: null,
  country: "united kingdom",
  isActive: true,
  currency: "gbp",
  baseFeeAmount: 500,
  feePerKgAmount: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.vendor.findMany.mockResolvedValue([
    { id: "v1", storeName: "Vendor A" },
    { id: "v2", storeName: "Vendor B" },
    { id: "v3", storeName: "Vendor C" },
  ] as never);
});

describe("deliveryService.calculate — per-vendor eligibility", () => {
  it("all vendors eligible: two vendors, neither has an override, both inherit the global zone", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp" },
      { vendorId: "v2", priceInCents: 2000, currency: "gbp" },
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never); // global lookup
    m.deliveryZone.findFirst.mockResolvedValue(null as never); // no vendor overrides

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "united kingdom" });

    expect(result.eligible).toBe(true);
    expect(result.vendors).toHaveLength(2);
    expect(result.vendors.every((v) => v.eligible)).toBe(true);
    expect(result.subtotalAmount).toBe(3000);
  });

  it("one vendor ineligible (explicitly deactivated their own zone for this country) — the other vendor stays valid", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp" },
      { vendorId: "v2", priceInCents: 2000, currency: "gbp" },
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never); // global lookup
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v1"
          ? { id: "zone-v1-off", vendorId: "v1", country: "united kingdom", isActive: false, currency: "gbp", baseFeeAmount: 100, feePerKgAmount: 0 }
          : null,
      ) as never,
    );

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "united kingdom" });

    expect(result.eligible).toBe(false);
    const v1 = result.vendors.find((v) => v.vendorId === "v1")!;
    const v2 = result.vendors.find((v) => v.vendorId === "v2")!;
    expect(v1.eligible).toBe(false);
    expect(v1.reason).toBe("VENDOR_ZONE_INACTIVE");
    expect(v1.productTitles).toEqual(["Item 0"]);
    expect(v2.eligible).toBe(true);
    // Only the eligible vendor's amount is included in the totals — an
    // ineligible vendor never silently inflates or blocks the rest.
    expect(result.subtotalAmount).toBe(2000);
  });

  it("multiple vendors ineligible for different reasons — the one remaining eligible vendor is still computed correctly", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp" },
      { vendorId: "v2", priceInCents: 2000, currency: "gbp" },
      { vendorId: "v3", priceInCents: 3000, currency: "gbp" },
    ]) as never);
    // No global zone at all for this country.
    m.deliveryZone.findFirst.mockResolvedValueOnce(null as never); // global lookup
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v1"
          ? { id: "zone-v1-off", vendorId: "v1", country: "narnia", isActive: false, currency: "gbp", baseFeeAmount: 100, feePerKgAmount: 0 }
          : where.vendorId === "v2"
            ? { id: "zone-v2", vendorId: "v2", country: "narnia", isActive: true, currency: "gbp", baseFeeAmount: 300, feePerKgAmount: 0 }
            : null, // v3: no override, no global zone → no coverage
      ) as never,
    );

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "narnia" });

    expect(result.eligible).toBe(false);
    const v1 = result.vendors.find((v) => v.vendorId === "v1")!;
    const v2 = result.vendors.find((v) => v.vendorId === "v2")!;
    const v3 = result.vendors.find((v) => v.vendorId === "v3")!;
    expect(v1.eligible).toBe(false);
    expect(v1.reason).toBe("VENDOR_ZONE_INACTIVE");
    expect(v2.eligible).toBe(true);
    expect(v3.eligible).toBe(false);
    expect(v3.reason).toBe("NO_COVERAGE");
    // Only v2's subtotal (2000) contributes — v1 and v3 are excluded.
    expect(result.subtotalAmount).toBe(2000);
  });

  it("different vendor zones: each eligible vendor's own zone fee is used independently, not one flat rate", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp", weightGrams: 0 },
      { vendorId: "v2", priceInCents: 1000, currency: "gbp", weightGrams: 0 },
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never);
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v1"
          ? { id: "zone-v1", vendorId: "v1", country: "united kingdom", isActive: true, currency: "gbp", baseFeeAmount: 150, feePerKgAmount: 0 }
          : null, // v2 falls back to the global zone (500 base)
      ) as never,
    );

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "united kingdom" });

    const v1 = result.vendors.find((v) => v.vendorId === "v1")!;
    const v2 = result.vendors.find((v) => v.vendorId === "v2")!;
    expect(v1.deliveryAmount).toBe(150);
    expect(v2.deliveryAmount).toBe(500);
    expect(result.deliveryAmount).toBe(650);
  });

  it("different currencies: the ineligible vendor's currency is never touched by FX, only the eligible vendor's is normalized", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "usd" }, // ineligible
      { vendorId: "v2", priceInCents: 1000, currency: "eur" }, // eligible
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never); // global, gbp
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v1"
          ? { id: "zone-v1-off", vendorId: "v1", country: "united kingdom", isActive: false, currency: "usd", baseFeeAmount: 100, feePerKgAmount: 0 }
          : null,
      ) as never,
    );

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "united kingdom", checkoutCurrency: "GBP" });

    expect(result.currency).toBe("gbp");
    const v1 = result.vendors.find((v) => v.vendorId === "v1")!;
    const v2 = result.vendors.find((v) => v.vendorId === "v2")!;
    expect(v1.eligible).toBe(false);
    expect(v1.subtotalAmount).toBeUndefined();
    expect(v2.eligible).toBe(true);
    // 1000 EUR-cents normalized to GBP at the reviewed reference rate: round(1000/1.17) = 855.
    expect(v2.subtotalAmount).toBe(855);
    expect(result.subtotalAmount).toBe(855);
  });

  it("address changed: the same vendor is eligible for one country and ineligible for another", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([{ vendorId: "v1", priceInCents: 1000, currency: "gbp" }]) as never);

    // First address: UK, global zone covers it.
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(null as never);
    const ukResult = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "united kingdom" });
    expect(ukResult.eligible).toBe(true);

    // Buyer changes address to a country with no coverage at all.
    m.deliveryZone.findFirst.mockResolvedValueOnce(null as never); // no global zone for "atlantis"
    m.deliveryZone.findFirst.mockResolvedValueOnce(null as never); // vendor has no override either
    const atlantisResult = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "atlantis" });
    expect(atlantisResult.eligible).toBe(false);
    expect(atlantisResult.vendors[0].reason).toBe("NO_COVERAGE");
  });

  it("delivery recalculation: re-running calculate reflects the vendor's current zone state each time, not a cached result", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([{ vendorId: "v1", priceInCents: 1000, currency: "gbp" }]) as never);

    // First call: vendor's zone is deactivated.
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce({
      id: "zone-v1", vendorId: "v1", country: "united kingdom", isActive: false, currency: "gbp", baseFeeAmount: 200, feePerKgAmount: 0,
    } as never);
    const before = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "united kingdom" });
    expect(before.eligible).toBe(false);

    // Vendor reactivates their zone; recalculating for the same address must
    // now show them as eligible again, using their own (not the global) fee.
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce({
      id: "zone-v1", vendorId: "v1", country: "united kingdom", isActive: true, currency: "gbp", baseFeeAmount: 200, feePerKgAmount: 0,
    } as never);
    const after = await deliveryService.calculate("buyer-1", { cartId: "c1", deliveryCountry: "united kingdom" });
    expect(after.eligible).toBe(true);
    expect(after.deliveryAmount).toBe(200);
  });
});
