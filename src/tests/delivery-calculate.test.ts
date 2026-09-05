/**
 * deliveryService.calculate() is what the buyer sees on the cart/checkout
 * screen BEFORE paying — it must produce the exact same total that
 * paymentsService.createPaymentIntent() will actually charge. Before this
 * fix it applied one flat global-zone fee to the whole cart's combined
 * weight, ignoring any vendor-specific delivery-zone override — the real,
 * TestFlight-reported "displayed total != backend total" bug for any
 * multi-vendor cart, or any single vendor with their own zone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    cart: { findUnique: vi.fn() },
    deliveryZone: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { deliveryService } from "../modules/delivery/delivery.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

const globalZone = {
  id: "zone-global",
  country: "united kingdom",
  isActive: true,
  currency: "gbp",
  baseFeeAmount: 500,
  feePerKgAmount: 100,
};

describe("deliveryService.calculate — matches paymentsService's real per-vendor charge", () => {
  it("404s when the cart is missing, 403s on a foreign cart, 400s on an empty cart", async () => {
    m.cart.findUnique.mockResolvedValueOnce(null);
    await expect(deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "z1" })).rejects.toMatchObject({ statusCode: 404 });

    m.cart.findUnique.mockResolvedValueOnce({ id: "c1", buyerId: "someone-else", items: [] } as never);
    await expect(deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "z1" })).rejects.toMatchObject({ statusCode: 403 });

    m.cart.findUnique.mockResolvedValueOnce({ id: "c1", buyerId: "buyer-1", items: [] } as never);
    await expect(deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "z1" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("normalizes a GBP delivery zone's fee into the checkout currency instead of rejecting a currency mismatch (real device bug: a valid address was rejected purely because the zone's native currency differed)", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "c1",
      buyerId: "buyer-1",
      items: [{ productId: "p1", quantity: 1, product: { vendorId: "v1", priceInCents: 1000, currency: "usd", weightGrams: 100 } }],
    } as never);
    m.deliveryZone.findUnique.mockResolvedValue(globalZone as never); // globalZone is GBP
    m.deliveryZone.findFirst.mockResolvedValue(null as never);

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "zone-global" });

    // Native GBP fee: 500 + ceil(100g/1000)*100 = 600 GBP-cents.
    // Normalized to USD at the reviewed reference rate (1 GBP = 1.28 USD): 768.
    expect(result.subtotalAmount).toBe(1000);
    expect(result.deliveryAmount).toBe(768);
    expect(result.totalAmount).toBe(1768);
    expect(result.currency).toBe("usd");
  });

  it("single vendor, no zone override: fee = global zone base + per-kg on that vendor's weight (unchanged baseline behavior)", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "c1",
      buyerId: "buyer-1",
      items: [{ productId: "p1", quantity: 2, product: { vendorId: "v1", priceInCents: 1000, currency: "gbp", weightGrams: 400 } }],
    } as never);
    m.deliveryZone.findUnique.mockResolvedValue(globalZone as never);
    m.deliveryZone.findFirst.mockResolvedValue(null as never); // no vendor-specific override

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "zone-global" });

    // subtotal = 1000*2 = 2000; weight = 400*2 = 800g -> ceil(0.8kg)=1kg -> fee = 500 + 1*100 = 600
    expect(result.subtotalAmount).toBe(2000);
    expect(result.deliveryAmount).toBe(600);
    expect(result.totalAmount).toBe(2600);
    expect(result.currency).toBe("gbp");
  });

  it("no normalization is applied when everything already shares one currency — no rate lookup, no rounding drift", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "c1",
      buyerId: "buyer-1",
      items: [{ productId: "p1", quantity: 1, product: { vendorId: "v1", priceInCents: 999, currency: "gbp", weightGrams: 250 } }],
    } as never);
    m.deliveryZone.findUnique.mockResolvedValue(globalZone as never);
    m.deliveryZone.findFirst.mockResolvedValue(null as never);

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "zone-global", checkoutCurrency: "GBP" });

    // 500 + ceil(250g/1000)*100 = 600 — exact, no FX rounding involved at all.
    expect(result.deliveryAmount).toBe(600);
    expect(result.currency).toBe("gbp");
  });

  it("a vendor's own zone override is honored in the displayed estimate — not just the flat global zone", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "c1",
      buyerId: "buyer-1",
      items: [{ productId: "p1", quantity: 1, product: { vendorId: "v1", priceInCents: 1000, currency: "gbp", weightGrams: 1000 } }],
    } as never);
    m.deliveryZone.findUnique.mockResolvedValue(globalZone as never);
    // Vendor's own zone: same currency, cheaper flat fee, no per-kg charge.
    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-vendor",
      country: "united kingdom",
      isActive: true,
      currency: "gbp",
      baseFeeAmount: 200,
      feePerKgAmount: 0,
    } as never);

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "zone-global" });

    // If this still used the flat global zone (500 + 1*100 = 600) instead of
    // the vendor's own override (200 + 0 = 200), this would fail at 600.
    expect(result.deliveryAmount).toBe(200);
    expect(result.totalAmount).toBe(1200);
  });

  it("honors the vendor's own zone even when its native currency differs from the checkout currency, normalizing its fee rather than ignoring it", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "c1",
      buyerId: "buyer-1",
      items: [{ productId: "p1", quantity: 1, product: { vendorId: "v1", priceInCents: 1000, currency: "gbp", weightGrams: 100 } }],
    } as never);
    m.deliveryZone.findUnique.mockResolvedValue(globalZone as never);
    // Vendor's own zone, denominated in EUR — no longer discarded for that
    // reason alone; its fee is normalized into the vendor's (== checkout,
    // here) currency instead.
    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-vendor-eur",
      country: "united kingdom",
      isActive: true,
      currency: "eur",
      baseFeeAmount: 1000,
      feePerKgAmount: 0,
    } as never);

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "zone-global" });

    // 1000 EUR-cents normalized to GBP at the reviewed reference rate
    // (1 GBP = 1.17 EUR, so 1 EUR = 1/1.17 GBP): round(1000 / 1.17) = 855.
    expect(result.deliveryAmount).toBe(855);
  });

  it("multi-vendor cart: sums each vendor's own fee independently, matching paymentsService's per-vendor grouping", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "c1",
      buyerId: "buyer-1",
      items: [
        { productId: "p1", quantity: 1, product: { vendorId: "v1", priceInCents: 1000, currency: "gbp", weightGrams: 1000 } },
        { productId: "p2", quantity: 1, product: { vendorId: "v2", priceInCents: 2000, currency: "gbp", weightGrams: 2000 } },
      ],
    } as never);
    m.deliveryZone.findUnique.mockResolvedValue(globalZone as never);
    // v1 has its own cheap flat-fee zone; v2 has no override (uses global).
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v1"
          ? { id: "zone-v1", country: "united kingdom", isActive: true, currency: "gbp", baseFeeAmount: 150, feePerKgAmount: 0 }
          : null,
      ) as never,
    );

    const result = await deliveryService.calculate("buyer-1", { cartId: "c1", destinationZoneId: "zone-global" });

    // v1: 150 (flat override). v2: global 500 + ceil(2kg)*100 = 700. Total = 850.
    // A single flat global-zone calc over the COMBINED 3kg weight (500 + 300 = 800,
    // ignoring v1's override entirely) would previously have been wrong here.
    expect(result.subtotalAmount).toBe(3000);
    expect(result.deliveryAmount).toBe(850);
    expect(result.totalAmount).toBe(3850);
  });
});
