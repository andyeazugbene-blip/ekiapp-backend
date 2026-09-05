/**
 * Tests for POST /api/payments/create-intent — verifies the response shape
 * required by mobile Stripe PaymentSheet.
 *
 * Required fields: paymentIntentId, clientSecret, checkoutId, orderIds[],
 *                  amount, currency.
 *
 * The payment record must NOT be marked PAID inside this endpoint —
 * only the Stripe webhook can mark a payment SUCCEEDED.
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

beforeEach(() => {
  vi.clearAllMocks();
  m.checkout.update.mockResolvedValue({} as never);
  // No active discount campaigns — irrelevant to the PaymentSheet response shape under test.
  m.campaign.findMany.mockResolvedValue([] as never);
});

const validInput = { cartId: "cart-1", deliveryCountry: "italy" };

describe("paymentsService.createPaymentIntent — PaymentSheet response shape", () => {
  it("404 when cart is missing", async () => {
    m.cart.findUnique.mockResolvedValue(null);
    await expect(paymentsService.createPaymentIntent(validInput, "buyer-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("403 when cart belongs to another buyer", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "someone-else",
      items: [{ productId: "p1", quantity: 1, product: { vendorId: "v1", priceInCents: 1000, currency: "eur", isActive: true, stock: 10, weightGrams: 100, title: "Item" } }],
    } as never);
    await expect(paymentsService.createPaymentIntent(validInput, "buyer-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("400 when cart is empty", async () => {
    m.cart.findUnique.mockResolvedValue({ id: "cart-1", buyerId: "buyer-1", items: [] } as never);
    await expect(paymentsService.createPaymentIntent(validInput, "buyer-1")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns paymentIntentId + clientSecret + checkoutId + orderIds + amount + currency", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [
        {
          productId: "p1",
          quantity: 2,
          product: {
            vendorId: "v1",
            priceInCents: 1500,
            currency: "eur",
            isActive: true,
            stock: 10,
            weightGrams: 200,
            title: "Olive Oil",
          },
        },
      ],
    } as never);

    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-1",
      country: "italy",
      isActive: true,
      currency: "eur",
      baseFeeAmount: 500,
      feePerKgAmount: 100,
    } as never);

    // Vendor-specific zone lookup returns null → fallback to global zone
    m.deliveryZone.findFirst.mockResolvedValueOnce({
      id: "zone-1",
      country: "italy",
      isActive: true,
      currency: "eur",
      baseFeeAmount: 500,
      feePerKgAmount: 100,
    } as never);

    // Mock the transaction to resolve with checkoutId + orderIds
    m.$transaction.mockResolvedValue({ checkoutId: "co-1", orderIds: ["ord-1"] } as never);

    mPiCreate.mockResolvedValue({
      id: "pi_test_abc",
      client_secret: "pi_test_abc_secret_xyz",
    } as never);

    const result = await paymentsService.createPaymentIntent(validInput, "buyer-1");

    expect(result.paymentIntentId).toBe("pi_test_abc");
    expect(result.clientSecret).toBe("pi_test_abc_secret_xyz");
    expect(result.checkoutId).toBe("co-1");
    expect(result.orderIds).toEqual(["ord-1"]);
    expect(result.currency).toBe("eur");
    expect(result.amount).toBeGreaterThan(0);

    // The PaymentIntent itself was created with the right idempotency shape
    const args = mPiCreate.mock.calls[0];
    expect(args[1]).toEqual(expect.objectContaining({ idempotencyKey: "pi:checkout:co-1" }));
  });

  it("Stripe failure throws controlled 502 (no fake paid status)", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [
        {
          productId: "p1",
          quantity: 1,
          product: {
            vendorId: "v1",
            priceInCents: 1000,
            currency: "eur",
            isActive: true,
            stock: 10,
            weightGrams: 100,
            title: "Item",
          },
        },
      ],
    } as never);

    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-1",
      country: "italy",
      isActive: true,
      currency: "eur",
      baseFeeAmount: 500,
      feePerKgAmount: 100,
    } as never);

    m.$transaction.mockResolvedValue({ checkoutId: "co-2", orderIds: ["ord-2"] } as never);
    mPiCreate.mockRejectedValue(new Error("Stripe is down"));

    await expect(paymentsService.createPaymentIntent(validInput, "buyer-1")).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("Payment provider"),
    });
  });

  it("rolls back stock and marks the order/payment/checkout FAILED when Stripe fails (no orphaned stock reservation)", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [
        {
          productId: "p1",
          quantity: 2,
          product: {
            vendorId: "v1",
            priceInCents: 1000,
            currency: "eur",
            isActive: true,
            stock: 10,
            weightGrams: 100,
            title: "Item",
          },
        },
      ],
    } as never);

    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-1",
      country: "italy",
      isActive: true,
      currency: "eur",
      baseFeeAmount: 500,
      feePerKgAmount: 100,
    } as never);

    // First $transaction call is the checkout transaction (stock already
    // decremented "for real" inside it in production — here we just return
    // its result, same as the other tests). Second call is this fix's
    // rollback transaction — assert it actually restores stock and marks
    // everything FAILED instead of leaving it PENDING forever.
    const rollbackTx = {
      product: { update: vi.fn().mockResolvedValue({}) },
      buyerWallet: { update: vi.fn().mockResolvedValue({ id: "wallet-1" }) },
      buyerWalletTransaction: { create: vi.fn().mockResolvedValue({}) },
      order: { updateMany: vi.fn().mockResolvedValue({}) },
      payment: { updateMany: vi.fn().mockResolvedValue({}) },
      checkout: { update: vi.fn().mockResolvedValue({}) },
    };
    m.$transaction
      .mockResolvedValueOnce({ checkoutId: "co-3", orderIds: ["ord-3"] } as never)
      .mockImplementationOnce(async (cb: any) => cb(rollbackTx));

    mPiCreate.mockRejectedValue(new Error("Stripe is down"));

    await expect(paymentsService.createPaymentIntent(validInput, "buyer-1")).rejects.toMatchObject({
      statusCode: 502,
    });

    expect(rollbackTx.product.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { stock: { increment: 2 } },
    });
    expect(rollbackTx.order.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["ord-3"] } },
      data: { status: "FAILED" },
    });
    expect(rollbackTx.payment.updateMany).toHaveBeenCalledWith({
      where: { orderId: { in: ["ord-3"] } },
      data: { status: "FAILED" },
    });
    expect(rollbackTx.checkout.update).toHaveBeenCalledWith({
      where: { id: "co-3" },
      data: { status: "FAILED" },
    });
    // No wallet was used in this checkout — the wallet reversal must not run.
    expect(rollbackTx.buyerWallet.update).not.toHaveBeenCalled();
  });

  it("rollback also reverses a wallet debit that was already applied before Stripe failed", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [
        {
          productId: "p1",
          quantity: 1,
          product: {
            vendorId: "v1",
            priceInCents: 5000,
            currency: "eur",
            isActive: true,
            stock: 10,
            weightGrams: 100,
            title: "Item",
          },
        },
      ],
    } as never);

    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-1",
      country: "italy",
      isActive: true,
      currency: "eur",
      baseFeeAmount: 500,
      feePerKgAmount: 100,
    } as never);

    m.buyerWallet.findUnique.mockResolvedValue({ id: "wallet-1", buyerId: "buyer-1", balance: 3000, currency: "eur" } as never);

    const rollbackTx = {
      product: { update: vi.fn().mockResolvedValue({}) },
      buyerWallet: { update: vi.fn().mockResolvedValue({ id: "wallet-1" }) },
      buyerWalletTransaction: { create: vi.fn().mockResolvedValue({}) },
      order: { updateMany: vi.fn().mockResolvedValue({}) },
      payment: { updateMany: vi.fn().mockResolvedValue({}) },
      checkout: { update: vi.fn().mockResolvedValue({}) },
    };
    m.$transaction
      .mockResolvedValueOnce({ checkoutId: "co-4", orderIds: ["ord-4"] } as never)
      .mockImplementationOnce(async (cb: any) => cb(rollbackTx));

    mPiCreate.mockRejectedValue(new Error("Stripe is down"));

    await expect(
      paymentsService.createPaymentIntent({ ...validInput, walletAmount: 3000 }, "buyer-1"),
    ).rejects.toMatchObject({ statusCode: 502 });

    expect(rollbackTx.buyerWallet.update).toHaveBeenCalledWith({
      where: { buyerId: "buyer-1" },
      data: { balance: { increment: 3000 } },
    });
    expect(rollbackTx.buyerWalletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "REFUND_CREDIT", amount: 3000 }),
    });
  });

  it("rejects a card charge in a currency Stripe doesn't support, instead of silently charging EUR for the same numeric amount", async () => {
    // GHS is not in Stripe's supported currency list — resolveStripeCurrency()
    // would otherwise fall back to "eur" while keeping the same integer
    // amount, i.e. charging 640.00 EUR for something priced at 640.00 GHS.
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [
        {
          productId: "p1",
          quantity: 1,
          product: {
            vendorId: "v1",
            priceInCents: 6500,
            currency: "ghs",
            isActive: true,
            stock: 10,
            weightGrams: 100,
            title: "Palm Oil",
          },
        },
      ],
    } as never);

    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-1",
      country: "ghana",
      isActive: true,
      currency: "ghs",
      baseFeeAmount: 500,
      feePerKgAmount: 100,
    } as never);

    await expect(paymentsService.createPaymentIntent(validInput, "buyer-1")).rejects.toMatchObject({
      statusCode: 400,
      code: "CURRENCY_NOT_SUPPORTED",
    });

    // Must fail before any stock/checkout/order is ever created.
    expect(m.$transaction).not.toHaveBeenCalled();
    expect(mPiCreate).not.toHaveBeenCalled();
  });

  it("normalizes a vendor's own zone override into the vendor's currency instead of discarding it for having a different native currency", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [
        {
          productId: "p1",
          quantity: 1,
          product: { vendorId: "v1", priceInCents: 1000, currency: "gbp", isActive: true, stock: 10, weightGrams: 100, title: "Item" },
        },
      ],
    } as never);

    // Global zone resolution (deliveryCountry path) — already currency-checked, known-good.
    m.deliveryZone.findFirst.mockResolvedValueOnce({
      id: "zone-global",
      country: "united kingdom",
      isActive: true,
      currency: "gbp",
      baseFeeAmount: 500,
      feePerKgAmount: 100,
    } as never);
    // Vendor-specific override, denominated in EUR while the vendor's own
    // products are GBP — no longer discarded for that reason; its fee gets
    // normalized into the vendor's (GBP) currency instead.
    m.deliveryZone.findFirst.mockResolvedValueOnce({
      id: "zone-vendor-eur",
      country: "united kingdom",
      isActive: true,
      currency: "eur",
      baseFeeAmount: 99999,
      feePerKgAmount: 0,
    } as never);

    m.$transaction.mockResolvedValue({ checkoutId: "co-5", orderIds: ["ord-5"] } as never);
    mPiCreate.mockResolvedValue({ id: "pi_test_gbp", client_secret: "pi_test_gbp_secret" } as never);

    const result = await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom" },
      "buyer-1",
    );

    // subtotal 1000 + the vendor's own EUR zone fee (99999 EUR-cents)
    // normalized into GBP at the reviewed reference rate
    // (1 GBP = 1.17 EUR, so round(99999 / 1.17) = 85469) = 86469.
    expect(result.amount).toBe(86469);
    expect(result.currency).toBe("gbp");
  });

  it("redeems a promo code (increments usedCount, records PromoRedemption) even when the client omits promoVendorId — real bug found via live E2E: redemption was gated on the raw, near-always-undefined payload.promoVendorId instead of the auto-resolved vendor id already used for the discount calculation, so a maxUses:1 coupon could be reused indefinitely", async () => {
    m.cart.findUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [
        {
          productId: "p1",
          quantity: 1,
          product: { vendorId: "v1", priceInCents: 1000, currency: "gbp", isActive: true, stock: 10, weightGrams: 100, title: "Item" },
        },
      ],
    } as never);
    m.deliveryZone.findFirst.mockResolvedValue({
      id: "zone-1",
      country: "united kingdom",
      isActive: true,
      currency: "gbp",
      baseFeeAmount: 0,
      feePerKgAmount: 0,
    } as never);
    // Client sends only `promoCode`, no `promoVendorId` — the normal case.
    m.promoCode.findFirst.mockResolvedValue({ id: "promo-1", vendorId: "v1" } as never);
    mValidatePromo.mockResolvedValue({ discountAmount: 100, code: "SAVE10", type: "PERCENTAGE", value: 10 } as never);

    const tx = {
      product: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      checkout: { create: vi.fn().mockResolvedValue({ id: "co-6" }) },
      order: { create: vi.fn().mockResolvedValue({ id: "ord-6" }) },
      orderItem: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      payment: { create: vi.fn().mockResolvedValue({ id: "pay-6", vendorEarningsAmount: 0, currency: "gbp" }) },
      promoCode: { findFirst: vi.fn().mockResolvedValue({ id: "promo-1", maxUses: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      promoRedemption: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    };
    m.$transaction.mockImplementationOnce(async (cb: any) => cb(tx));

    mPiCreate.mockResolvedValue({ id: "pi_test_promo", client_secret: "pi_test_promo_secret" } as never);

    await paymentsService.createPaymentIntent(
      { cartId: "cart-1", deliveryCountry: "united kingdom", promoCode: "SAVE10" },
      "buyer-1",
    );

    expect(tx.promoCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "promo-1", usedCount: { lt: 1 } }), data: expect.objectContaining({ usedCount: { increment: 1 } }) }),
    );
    expect(tx.promoRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ promoCodeId: "promo-1", buyerId: "buyer-1" }) }),
    );
  });
});
