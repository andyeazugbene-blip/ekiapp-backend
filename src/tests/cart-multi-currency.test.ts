/**
 * Cart currency architecture — one Cart row per (buyer, currency), replacing
 * the old "one cart per buyer, block on currency mismatch, force a
 * destructive 'start a new cart'" flow (device QA finding, 2026-09).
 * These prove the real behavior end to end: adding a different-currency
 * product creates/uses a SEPARATE cart rather than throwing or clearing
 * anything, existing carts are never destroyed, and each currency-cart
 * stays internally single-currency.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("../lib/prisma", () => ({
  prisma: {
    cart: { upsert: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    cartItem: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    product: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "../lib/prisma";
import { cartService } from "../modules/cart/cart.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  // addItem/updateItem/removeItem/clearCart all run inside prisma.$transaction —
  // reuse the same mocked prisma object as `tx` since our mocks don't care
  // which name they're invoked through.
  m.$transaction.mockImplementation(async (cb: any) => cb(m));
});

function product(overrides: Partial<{ id: string; currency: string; isActive: boolean; stock: number }> = {}) {
  return { id: "prod-1", currency: "EUR", isActive: true, stock: 10, ...overrides };
}

function emptyCart(overrides: Partial<{ id: string; buyerId: string; currency: string; items: unknown[] }> = {}) {
  return { id: "cart-eur", buyerId: "buyer-1", currency: "EUR", items: [], ...overrides };
}

describe("cartService.addItem — routes by currency, never blocks or destroys", () => {
  it("1. EUR product with no existing cart creates and uses a EUR cart", async () => {
    m.product.findUnique.mockResolvedValue(product({ currency: "EUR" }) as never);
    m.cart.upsert.mockResolvedValue(emptyCart({ id: "cart-eur", currency: "EUR" }) as never);
    m.cartItem.create.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValue({ ...emptyCart({ currency: "EUR" }), items: [{ id: "item-1", productId: "prod-1", quantity: 1, product: product() }] } as never);

    await cartService.addItem("buyer-1", { productId: "prod-1", quantity: 1 });

    expect(m.cart.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buyerId_currency: { buyerId: "buyer-1", currency: "EUR" } } }),
    );
    expect(m.cartItem.create).toHaveBeenCalledWith({ data: { cartId: "cart-eur", productId: "prod-1", quantity: 1 } });
  });

  it("2. USD product with no existing cart creates and uses a USD cart", async () => {
    m.product.findUnique.mockResolvedValue(product({ currency: "USD" }) as never);
    m.cart.upsert.mockResolvedValue(emptyCart({ id: "cart-usd", currency: "USD" }) as never);
    m.cartItem.create.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValue(emptyCart({ id: "cart-usd", currency: "USD" }) as never);

    await cartService.addItem("buyer-1", { productId: "prod-1", quantity: 1 });

    expect(m.cart.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buyerId_currency: { buyerId: "buyer-1", currency: "USD" } } }),
    );
  });

  it("3. buyer with an existing EUR cart adding a USD product creates a SEPARATE USD cart — the EUR cart is never touched or cleared", async () => {
    m.product.findUnique.mockResolvedValue(product({ id: "prod-usd", currency: "usd" }) as never); // lowercase from a sloppy seed — must still normalize
    // getOrCreateCart is called fresh each time (upsert) — it returns whatever cart matches THIS currency, not the buyer's other cart.
    m.cart.upsert.mockResolvedValue(emptyCart({ id: "cart-usd", currency: "USD" }) as never);
    m.cartItem.create.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValue({ ...emptyCart({ id: "cart-usd", currency: "USD" }), items: [{ id: "item-2", productId: "prod-usd", quantity: 1, product: product({ id: "prod-usd", currency: "usd" }) }] } as never);

    await cartService.addItem("buyer-1", { productId: "prod-usd", quantity: 1 });

    // Upserts the USD cart specifically — never reads or mutates a "cart-eur" row at all.
    expect(m.cart.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buyerId_currency: { buyerId: "buyer-1", currency: "USD" } } }),
    );
    expect(m.cartItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cartId: "cart-usd" }) }));
    // No deleteMany/delete call anywhere — nothing was cleared.
    expect(m.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(m.cartItem.delete).not.toHaveBeenCalled();
  });

  it("4. buyer with an existing USD cart adding a EUR product creates a SEPARATE EUR cart", async () => {
    m.product.findUnique.mockResolvedValue(product({ currency: "EUR" }) as never);
    m.cart.upsert.mockResolvedValue(emptyCart({ id: "cart-eur-2", currency: "EUR" }) as never);
    m.cartItem.create.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValue(emptyCart({ id: "cart-eur-2", currency: "EUR" }) as never);

    await cartService.addItem("buyer-1", { productId: "prod-1", quantity: 1 });

    expect(m.cart.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buyerId_currency: { buyerId: "buyer-1", currency: "EUR" } } }),
    );
    expect(m.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  it("5. mixed vendor currencies — a GBP-vendor product and a EUR-vendor product land in two different currency-carts, not merged and not rejected", async () => {
    m.product.findUnique.mockResolvedValueOnce(product({ id: "prod-gbp", currency: "GBP" }) as never);
    m.cart.upsert.mockResolvedValueOnce(emptyCart({ id: "cart-gbp", currency: "GBP" }) as never);
    m.cartItem.create.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValueOnce(emptyCart({ id: "cart-gbp", currency: "GBP" }) as never);
    await cartService.addItem("buyer-1", { productId: "prod-gbp", quantity: 1 });

    m.product.findUnique.mockResolvedValueOnce(product({ id: "prod-eur", currency: "EUR" }) as never);
    m.cart.upsert.mockResolvedValueOnce(emptyCart({ id: "cart-eur-3", currency: "EUR" }) as never);
    m.cart.findUnique.mockResolvedValueOnce(emptyCart({ id: "cart-eur-3", currency: "EUR" }) as never);
    await cartService.addItem("buyer-1", { productId: "prod-eur", quantity: 1 });

    const upsertCurrencies = m.cart.upsert.mock.calls.map((call: any) => call[0].where.buyerId_currency.currency);
    expect(upsertCurrencies).toEqual(["GBP", "EUR"]);
  });

  it("stacks quantity for a repeat add of the same product within its own currency-cart", async () => {
    m.product.findUnique.mockResolvedValue(product({ stock: 10 }) as never);
    m.cart.upsert.mockResolvedValue({ ...emptyCart(), items: [{ id: "item-1", productId: "prod-1", quantity: 2, product: product() }] } as never);
    m.cartItem.update.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValue(emptyCart() as never);

    await cartService.addItem("buyer-1", { productId: "prod-1", quantity: 3 });

    expect(m.cartItem.update).toHaveBeenCalledWith({ where: { id: "item-1" }, data: { quantity: 5 } });
    expect(m.cartItem.create).not.toHaveBeenCalled();
  });

  it("rejects when the new total quantity exceeds real stock", async () => {
    m.product.findUnique.mockResolvedValue(product({ stock: 2 }) as never);
    m.cart.upsert.mockResolvedValue(emptyCart() as never);

    await expect(cartService.addItem("buyer-1", { productId: "prod-1", quantity: 5 })).rejects.toMatchObject({ statusCode: 400 });
    expect(m.cartItem.create).not.toHaveBeenCalled();
  });
});

describe("cartService.getCart — active-cart resolution and explicit currency lookup", () => {
  it("6a. with no currency argument, returns the buyer's most-recently-updated cart (the 'active' cart)", async () => {
    m.cart.findFirst.mockResolvedValue(emptyCart({ id: "cart-usd", currency: "USD", items: [{ id: "i1" }] }) as never);

    const result = await cartService.getCart("buyer-1");

    expect(m.cart.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buyerId: "buyer-1" }, orderBy: { updatedAt: "desc" } }),
    );
    expect(result.currency).toBe("USD");
  });

  it("6b. with an explicit currency, returns THAT cart untouched — proving the other (inactive) currency-cart's data survives a switch", async () => {
    m.cart.upsert.mockResolvedValue(emptyCart({ id: "cart-eur", currency: "EUR", items: [{ id: "old-item", productId: "prod-1", quantity: 4 }] }) as never);

    const result = await cartService.getCart("buyer-1", "eur");

    expect(m.cart.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { buyerId_currency: { buyerId: "buyer-1", currency: "EUR" } } }));
    expect(result.items).toEqual([{ id: "old-item", productId: "prod-1", quantity: 4 }]);
  });

  it("creates a fresh EUR cart for a buyer who has genuinely never had any cart", async () => {
    m.cart.findFirst.mockResolvedValue(null as never);
    m.cart.upsert.mockResolvedValue(emptyCart({ currency: "EUR" }) as never);

    const result = await cartService.getCart("brand-new-buyer");

    expect(result.currency).toBe("EUR");
  });
});

describe("cartService.listCartsSummary — real per-currency counts, empty carts excluded", () => {
  it("returns only non-empty carts with correct aggregated item counts", async () => {
    m.cart.findMany.mockResolvedValue([
      { currency: "EUR", updatedAt: new Date("2026-09-05T10:00:00Z"), items: [{ quantity: 2 }, { quantity: 1 }] },
      { currency: "USD", updatedAt: new Date("2026-09-05T09:00:00Z"), items: [] },
      { currency: "GBP", updatedAt: new Date("2026-09-04T00:00:00Z"), items: [{ quantity: 5 }] },
    ] as never);

    const summary = await cartService.listCartsSummary("buyer-1");

    expect(summary).toEqual([
      { currency: "EUR", itemCount: 3, updatedAt: "2026-09-05T10:00:00.000Z" },
      { currency: "GBP", itemCount: 5, updatedAt: "2026-09-04T00:00:00.000Z" },
    ]);
  });
});

describe("cartService.updateItem / removeItem — ownership resolved through the item's own cart, regardless of which currency-cart it's in", () => {
  it("updates an item that lives in a non-active currency-cart without needing to know which currency it is", async () => {
    m.cartItem.findUnique.mockResolvedValue({ id: "item-1", cartId: "cart-usd", product: product({ stock: 10 }), cart: { buyerId: "buyer-1" } } as never);
    m.cartItem.update.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValue(emptyCart({ id: "cart-usd", currency: "USD" }) as never);

    await cartService.updateItem("buyer-1", "item-1", { quantity: 2 });

    expect(m.cartItem.update).toHaveBeenCalledWith({ where: { id: "item-1" }, data: { quantity: 2 } });
  });

  it("refuses to update another buyer's cart item (cross-buyer ownership check survives the multi-cart change)", async () => {
    m.cartItem.findUnique.mockResolvedValue({ id: "item-1", cartId: "cart-usd", product: product(), cart: { buyerId: "someone-else" } } as never);

    await expect(cartService.updateItem("buyer-1", "item-1", { quantity: 2 })).rejects.toMatchObject({ statusCode: 404 });
    expect(m.cartItem.update).not.toHaveBeenCalled();
  });

  it("removes an item from whichever currency-cart it belongs to", async () => {
    m.cartItem.findUnique.mockResolvedValue({ id: "item-1", cartId: "cart-eur", cart: { buyerId: "buyer-1" } } as never);
    m.cartItem.delete.mockResolvedValue({} as never);
    m.cart.findUnique.mockResolvedValue(emptyCart({ id: "cart-eur" }) as never);

    await cartService.removeItem("buyer-1", "item-1");

    expect(m.cartItem.delete).toHaveBeenCalledWith({ where: { id: "item-1" } });
  });
});

describe("cartService.clearCart — 7. requires a currency, clears only that one currency-cart", () => {
  it("clears the EUR cart's items without touching any other currency-cart", async () => {
    m.cart.upsert.mockResolvedValue({ ...emptyCart({ id: "cart-eur", currency: "EUR" }), items: [{ id: "i1" }] } as never);
    m.cartItem.deleteMany.mockResolvedValue({ count: 1 } as never);
    m.cart.findUnique.mockResolvedValue(emptyCart({ id: "cart-eur", currency: "EUR" }) as never);

    await cartService.clearCart("buyer-1", "eur");

    expect(m.cartItem.deleteMany).toHaveBeenCalledWith({ where: { cartId: "cart-eur" } });
  });
});

describe("8. checkout cart-clearing uses the checked-out cart's own id, not a fresh buyerId lookup (regression guard)", () => {
  const paymentsServiceSource = fs.readFileSync(
    path.join(__dirname, "..", "modules", "payments", "payments.service.ts"),
    "utf8",
  );
  const stripeServiceSource = fs.readFileSync(
    path.join(__dirname, "..", "modules", "stripe", "stripe.service.ts"),
    "utf8",
  );

  it("payments.service wallet-only success path clears cartItem by the already-loaded cart.id, never by a buyerId-keyed cart lookup", () => {
    expect(paymentsServiceSource).toMatch(/cartItem\.deleteMany\(\{ where: \{ cartId: cart\.id \} \}\)/);
    expect(paymentsServiceSource).not.toMatch(/tx\.cart\.findUnique\(\{ where: \{ buyerId \}/);
  });

  it("stripe webhook cart-clearing looks up the cart by (buyerId, currency), scoped to the checkout's own currency", () => {
    expect(stripeServiceSource).toMatch(/buyerId_currency: \{ buyerId, currency: currency\.toUpperCase\(\) \}/);
    expect(stripeServiceSource).toMatch(/clearBuyerCart\(tx, buyerId, checkout\.currency\)/);
  });
});
