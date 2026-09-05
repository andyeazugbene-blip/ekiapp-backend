/**
 * Multi-currency checkout — a buyer's cart may hold products from vendors
 * with different NATIVE currencies (Product.currency inherits from
 * Vendor.currency, immutable). Every line item and delivery fee must be
 * normalized into exactly ONE checkout currency before Stripe ever sees an
 * amount — this is the real device-reported architecture requirement
 * (device QA: "Different currency" / "Start new cart" must never recur),
 * not a copy change. These prove the actual math and the actual single-
 * currency Stripe call, not just that a request doesn't throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

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
  stripe: {
    paymentIntents: { create: vi.fn() },
  },
}));

vi.mock("../modules/promos/promos.service", () => ({
  promosService: { validatePromo: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { promosService } from "../modules/promos/promos.service";
import { paymentsService } from "../modules/payments/payments.service";

const m = vi.mocked(prisma, true);
const mPiCreate = vi.mocked(stripe.paymentIntents.create);
const mValidatePromo = vi.mocked(promosService.validatePromo);

const globalZone = {
  id: "zone-global",
  country: "united kingdom",
  isActive: true,
  currency: "gbp",
  baseFeeAmount: 0,
  feePerKgAmount: 0,
};

function cartWith(items: { vendorId: string; priceInCents: number; currency: string; weightGrams?: number }[]) {
  return {
    id: "cart-1",
    buyerId: "buyer-1",
    items: items.map((it, i) => ({
      productId: `p${i}`,
      quantity: 1,
      product: { vendorId: it.vendorId, priceInCents: it.priceInCents, currency: it.currency, isActive: true, stock: 10, weightGrams: it.weightGrams ?? 0, title: `Item ${i}` },
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.checkout.update.mockResolvedValue({} as never);
  m.campaign.findMany.mockResolvedValue([] as never);
  m.deliveryZone.findUnique.mockResolvedValue(globalZone as never);
  // deliveryCountry resolution calls findFirst for the global zone itself
  // (first call), then findFirst again per vendor group looking for an
  // override — none exists in these scenarios, so every call after the
  // first returns null.
  m.deliveryZone.findFirst.mockResolvedValueOnce(globalZone as never);
  m.deliveryZone.findFirst.mockResolvedValue(null as never);
  m.$transaction.mockResolvedValue({ checkoutId: "co-1", orderIds: ["ord-1"] } as never);
  mPiCreate.mockResolvedValue({ id: "pi_multi", client_secret: "secret_multi" } as never);
});

describe("1/2. single-currency checkouts need no conversion", () => {
  it("EUR product in EUR checkout — exact native total, no FX involved", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([{ vendorId: "v1", priceInCents: 2000, currency: "eur" }]) as never);
    const result = await paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "united kingdom" }, "buyer-1");
    expect(result.amount).toBe(2000);
    expect(result.currency).toBe("eur");
    expect(result.conversionApplied).toBe(false);
  });

  it("USD product in USD checkout — exact native total, no FX involved", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([{ vendorId: "v1", priceInCents: 3000, currency: "usd" }]) as never);
    const result = await paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "united kingdom" }, "buyer-1");
    expect(result.amount).toBe(3000);
    expect(result.currency).toBe("usd");
    expect(result.conversionApplied).toBe(false);
  });
});

describe("3/4. EUR + USD in one cart — the real device-reported scenario", () => {
  it("checkout currency = USD: the EUR item is normalized, the USD item passes through unchanged", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v-eur", priceInCents: 1000, currency: "eur" },
      { vendorId: "v-usd", priceInCents: 500, currency: "usd" },
    ]) as never);

    const result = await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom", checkoutCurrency: "USD" },
      "buyer-1",
    );

    // EUR 1000 normalized to USD (1 GBP=1.28 USD, 1 GBP=1.17 EUR -> 1 EUR = 1.28/1.17 USD): round(1000 * 1.28/1.17) = 1094
    // + USD 500 unchanged = 1594
    expect(result.amount).toBe(1094 + 500);
    expect(result.currency).toBe("usd");
    expect(result.conversionApplied).toBe(true);
    // Exactly one Stripe PaymentIntent, in exactly one currency, for the WHOLE mixed-currency cart.
    expect(mPiCreate).toHaveBeenCalledTimes(1);
    expect(mPiCreate.mock.calls[0][0]).toMatchObject({ currency: "usd" });
  });

  it("checkout currency = EUR (the buyer switching currency): same cart, same products, different normalized total — no cart mutation involved", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v-eur", priceInCents: 1000, currency: "eur" },
      { vendorId: "v-usd", priceInCents: 500, currency: "usd" },
    ]) as never);

    const result = await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom", checkoutCurrency: "EUR" },
      "buyer-1",
    );

    // EUR 1000 unchanged + USD 500 normalized to EUR (round(500 * 1.17/1.28) = 457) = 1457
    expect(result.amount).toBe(1000 + 457);
    expect(result.currency).toBe("eur");
    // 16. Switching checkout currency never touches the cart itself — no
    // cart/cartItem mutation call exists anywhere in this flow.
    expect(m.cart.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("5/8/9. three vendors, three native currencies, one checkout", () => {
  it("EUR + USD + GBP vendors, checkout currency GBP: sums every normalized order into one GBP total", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v-eur", priceInCents: 1000, currency: "eur" },
      { vendorId: "v-usd", priceInCents: 1000, currency: "usd" },
      { vendorId: "v-gbp", priceInCents: 1000, currency: "gbp" },
    ]) as never);

    const result = await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom", checkoutCurrency: "GBP" },
      "buyer-1",
    );

    const eurToGbp = Math.round(1000 / 1.17); // 855
    const usdToGbp = Math.round(1000 / 1.28); // 781
    expect(result.amount).toBe(eurToGbp + usdToGbp + 1000);
    expect(result.currency).toBe("gbp");
    expect(result.conversionApplied).toBe(true);
    expect(mPiCreate).toHaveBeenCalledTimes(1);
  });
});

describe("10. Stripe never receives a mismatched currency", () => {
  it("stripeAmount and PaymentIntent.currency both reflect checkoutCurrency, never a native vendor currency", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v-eur", priceInCents: 5000, currency: "eur" },
    ]) as never);

    await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom", checkoutCurrency: "usd" },
      "buyer-1",
    );

    const [args] = mPiCreate.mock.calls[0];
    expect(args.currency).toBe("usd");
    expect(args.amount).toBe(Math.round(5000 * 1.28 / 1.17));
  });
});

describe("7. discount normalization — promo discount is applied natively, then the ALREADY-discounted total is normalized", () => {
  it("a promo discount on the EUR vendor still reduces the checkout-currency total correctly", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v-eur", priceInCents: 1000, currency: "eur" },
    ]) as never);
    m.promoCode.findFirst.mockResolvedValue({ vendorId: "v-eur" } as never);
    mValidatePromo.mockResolvedValue({ discountAmount: 200, discountType: "FIXED" } as never);

    const result = await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom", checkoutCurrency: "usd", promoCode: "SAVE2" },
      "buyer-1",
    );

    // Native EUR subtotal 1000 - 200 discount = 800 EUR-cents, normalized
    // to USD: round(800 * 1.28/1.17) = 875.
    expect(result.amount).toBe(Math.round(800 * 1.28 / 1.17));
    expect(result.discountAmount).toBe(200);
  });
});

describe("11/2G. refund safety — no refund code path ever recomputes an FX rate", () => {
  it("admin refund controller and Community Buy refund retry never import the FX normalizer — a refund must reference the ORIGINAL stored conversion, never a freshly-fetched rate", () => {
    const files = [
      path.join(__dirname, "..", "modules", "admin", "admin-refunds.controller.ts"),
      path.join(__dirname, "..", "modules", "community-buy", "campaign-contributions.service.ts"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/fx-normalizer|getFxRate|normalizeMoneyMinor/);
    }
  });
});

describe("13/14/15. an unsupported/missing FX rate blocks checkout rather than guessing", () => {
  it("rejects with a clear error instead of charging a fabricated conversion when no reviewed rate exists", async () => {
    m.cart.findUnique.mockResolvedValue(cartWith([
      { vendorId: "v-zar", priceInCents: 1000, currency: "zar" },
    ]) as never);

    await expect(
      paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "united kingdom", checkoutCurrency: "usd" }, "buyer-1"),
    ).rejects.toMatchObject({ statusCode: 400, code: "FX_RATE_UNAVAILABLE" });

    expect(mPiCreate).not.toHaveBeenCalled();
  });
});
