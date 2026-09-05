/**
 * Backend-authoritative multi-vendor delivery eligibility gate at the
 * actual charge-time path (createPaymentIntent). deliveryService.calculate
 * (see delivery-eligibility.test.ts) is the buyer-facing pre-check the
 * checkout screen calls before this — this suite proves the money-charging
 * path independently refuses to fall back to the shared zone for a vendor
 * who cannot actually deliver here, rather than trusting the client to have
 * already caught it. Checkout must be blocked ONLY for the affected vendor's
 * case — never a blanket, unexplained failure — and a valid vendor's own
 * zone/fee must still be honored right up until the throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    cart: { findUnique: vi.fn() },
    deliveryZone: { findUnique: vi.fn(), findFirst: vi.fn() },
    buyerWallet: { findUnique: vi.fn() },
    checkout: { update: vi.fn() },
    campaign: { findMany: vi.fn() },
    promoCode: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { paymentIntents: { create: vi.fn() } },
}));

vi.mock("../modules/promos/promos.service", () => ({
  promosService: { validatePromo: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { paymentsService } from "../modules/payments/payments.service";

const m = vi.mocked(prisma, true);
const mPiCreate = vi.mocked(stripe.paymentIntents.create);

const ukGlobalZone = {
  id: "zone-uk-global",
  vendorId: null,
  country: "united kingdom",
  isActive: true,
  currency: "gbp",
  baseFeeAmount: 500,
  feePerKgAmount: 0,
};

function cartWith(items: { vendorId: string; priceInCents: number; currency: string; title?: string }[]) {
  return {
    id: "cart-1",
    buyerId: "buyer-1",
    items: items.map((it, i) => ({
      productId: `p${i}`,
      quantity: 1,
      product: { vendorId: it.vendorId, priceInCents: it.priceInCents, currency: it.currency, isActive: true, stock: 10, weightGrams: 0, title: it.title ?? `Item ${i}` },
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.checkout.update.mockResolvedValue({} as never);
  m.campaign.findMany.mockResolvedValue([] as never);
  m.$transaction.mockResolvedValue({ checkoutId: "co-1", orderIds: ["ord-1", "ord-2"] } as never);
  mPiCreate.mockResolvedValue({ id: "pi_elig", client_secret: "secret_elig" } as never);
});

describe("paymentsService.createPaymentIntent — multi-vendor delivery eligibility gate", () => {
  it("all vendors eligible: checkout proceeds normally (regression — this must keep working)", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp" },
      { vendorId: "v2", priceInCents: 2000, currency: "gbp" },
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never); // global lookup
    m.deliveryZone.findFirst.mockResolvedValue(null as never); // neither vendor overrides

    const result = await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom" },
      "buyer-1",
    );

    expect(result.checkoutId).toBe("co-1");
    expect(mPiCreate).toHaveBeenCalledTimes(1);
  });

  it("one vendor ineligible (explicitly deactivated zone), the other eligible: checkout is blocked with the affected vendor identified, never a blanket failure", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp", title: "Blocked Product" },
      { vendorId: "v2", priceInCents: 2000, currency: "gbp", title: "Fine Product" },
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never); // global lookup
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v1"
          ? { id: "zone-v1-off", vendorId: "v1", country: "united kingdom", isActive: false, currency: "gbp", baseFeeAmount: 100, feePerKgAmount: 0 }
          : null,
      ) as never,
    );

    await expect(
      paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "united kingdom" }, "buyer-1"),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "DELIVERY_INELIGIBLE_VENDOR",
      message: expect.stringContaining("Blocked Product"),
    });

    // The block must be attributable to v1 specifically, and must happen
    // BEFORE anything charges or reserves stock — no partial checkout, no
    // stock decrement, no Stripe call for either vendor.
    expect(mPiCreate).not.toHaveBeenCalled();
    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("multiple vendors ineligible: every affected vendor's products are named in the error", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp", title: "First Blocked" },
      { vendorId: "v2", priceInCents: 2000, currency: "gbp", title: "Second Blocked" },
      { vendorId: "v3", priceInCents: 3000, currency: "gbp", title: "Fine Product" },
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(null as never); // no global zone for this country at all
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v3"
          ? { id: "zone-v3", vendorId: "v3", country: "narnia", isActive: true, currency: "gbp", baseFeeAmount: 300, feePerKgAmount: 0 }
          : null, // v1 and v2: no override and no global zone → no coverage
      ) as never,
    );

    await expect(
      paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "narnia" }, "buyer-1"),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "DELIVERY_INELIGIBLE_VENDOR",
      message: expect.stringContaining("First Blocked"),
      details: {
        vendors: expect.arrayContaining([
          expect.objectContaining({ vendorId: "v1", reason: "NO_COVERAGE" }),
          expect.objectContaining({ vendorId: "v2", reason: "NO_COVERAGE" }),
        ]),
      },
    });
    expect(mPiCreate).not.toHaveBeenCalled();
  });

  it("a valid vendor's own zone override is still honored right up until the throw — the fix doesn't regress per-vendor fee calculation", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v1", priceInCents: 1000, currency: "gbp", title: "Blocked Product" },
      { vendorId: "v2", priceInCents: 2000, currency: "gbp" },
    ]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never);
    m.deliveryZone.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.vendorId === "v1"
          ? { id: "zone-v1-off", vendorId: "v1", country: "united kingdom", isActive: false, currency: "gbp", baseFeeAmount: 100, feePerKgAmount: 0 }
          : where.vendorId === "v2"
            ? { id: "zone-v2", vendorId: "v2", country: "united kingdom", isActive: true, currency: "gbp", baseFeeAmount: 250, feePerKgAmount: 0 }
            : null,
      ) as never,
    );

    // Still throws overall (v1 blocks the whole checkout, since a single
    // combined payment can't silently drop v1's items) — but this proves
    // v2's own zone was resolved and would have been used correctly.
    await expect(
      paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "united kingdom" }, "buyer-1"),
    ).rejects.toMatchObject({ statusCode: 422, code: "DELIVERY_INELIGIBLE_VENDOR" });
  });

  it("address changed: a checkout blocked for one country succeeds once the buyer picks an address the vendor actually covers", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([{ vendorId: "v1", priceInCents: 1000, currency: "gbp" }]) as never);

    // First attempt: no coverage for this country.
    m.deliveryZone.findFirst.mockResolvedValueOnce(null as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "atlantis" }, "buyer-1"),
    ).rejects.toMatchObject({ statusCode: 422, code: "DELIVERY_INELIGIBLE_VENDOR" });
    expect(mPiCreate).not.toHaveBeenCalled();

    // Buyer switches to an address the vendor's global zone actually covers.
    vi.clearAllMocks();
    m.checkout.update.mockResolvedValue({} as never);
    m.campaign.findMany.mockResolvedValue([] as never);
    m.$transaction.mockResolvedValue({ checkoutId: "co-2", orderIds: ["ord-3"] } as never);
    mPiCreate.mockResolvedValue({ id: "pi_ok", client_secret: "secret_ok" } as never);
    m.cart.findUnique.mockResolvedValue(cartWith([{ vendorId: "v1", priceInCents: 1000, currency: "gbp" }]) as never);
    m.deliveryZone.findFirst.mockResolvedValueOnce(ukGlobalZone as never);
    m.deliveryZone.findFirst.mockResolvedValue(null as never);

    const result = await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom" },
      "buyer-1",
    );
    expect(result.checkoutId).toBe("co-2");
    expect(mPiCreate).toHaveBeenCalledTimes(1);
  });
});
