import type { Cart, CartItem, Prisma, Product } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { AddCartItemInput, CartSummaryEntry, UpdateCartItemInput } from "./cart.types";

type CartWithItems = Cart & { items: (CartItem & { product: Product })[] };

function includeItems() {
  return {
    items: {
      include: { product: true },
      orderBy: { createdAt: "asc" as const },
    },
  };
}

async function getOrCreateCart(
  buyerId: string,
  currency: string,
  tx: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<CartWithItems> {
  // Use upsert to prevent a race condition (unique on [buyerId, currency]).
  const cart = await tx.cart.upsert({
    where: { buyerId_currency: { buyerId, currency } },
    update: {},
    create: { buyerId, currency },
    include: includeItems(),
  });
  return cart as CartWithItems;
}

async function getActiveCart(
  buyerId: string,
  tx: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<CartWithItems | null> {
  const cart = await tx.cart.findFirst({
    where: { buyerId },
    orderBy: { updatedAt: "desc" },
    include: includeItems(),
  });
  return cart as CartWithItems | null;
}

function assertProductPurchasable(product: Product | null, requestedQty: number): asserts product is Product {
  if (!product) {
    throw new AppError("Product not found", 404);
  }
  if (!product.isActive) {
    throw new AppError("Product is not available", 400);
  }
  if (product.stock < requestedQty) {
    throw new AppError("Insufficient stock", 400);
  }
}

export const cartService = {
  // With a currency, returns that specific currency-cart (creating an empty
  // one if the buyer has never had one). Without one, returns the buyer's
  // most-recently-touched cart across all currencies — the "active" cart —
  // or a fresh default-currency cart if they have never had any cart at all.
  async getCart(buyerId: string, currency?: string): Promise<CartWithItems> {
    if (currency) return getOrCreateCart(buyerId, currency.toUpperCase());
    const active = await getActiveCart(buyerId);
    if (active) return active;
    return getOrCreateCart(buyerId, "EUR");
  },

  // Real per-currency summaries for the buyer's cart switcher — only carts
  // that actually have items are worth surfacing to the UI.
  async listCartsSummary(buyerId: string): Promise<CartSummaryEntry[]> {
    const carts = await prisma.cart.findMany({
      where: { buyerId },
      include: { items: { select: { quantity: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return carts
      .filter((cart) => cart.items.length > 0)
      .map((cart) => ({
        currency: cart.currency,
        itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
        updatedAt: cart.updatedAt.toISOString(),
      }));
  },

  async addItem(buyerId: string, input: AddCartItemInput): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: input.productId } });
      if (!product) throw new AppError("Product not found", 404);
      if (!product.isActive) throw new AppError("Product is not available", 400);

      // A product's currency is fixed (inherited from its vendor, never
      // client-settable — see products.service.ts). Route the item straight
      // to the buyer's cart FOR THAT CURRENCY, creating it on first use.
      // This is the multi-cart-by-currency design: adding a product never
      // throws a "different currency, start a new cart" error and never
      // destroys an existing cart — each currency simply has its own.
      const currency = product.currency.toUpperCase();
      const cart = await getOrCreateCart(buyerId, currency, tx);

      // Multi-vendor: no vendor restriction — items from any vendor allowed
      // (as long as they share this cart's currency).
      const existingItem = cart.items.find((item) => item.productId === product.id);
      const newQuantity = (existingItem?.quantity ?? 0) + input.quantity;

      if (product.stock < newQuantity) {
        throw new AppError("Insufficient stock", 400);
      }

      if (existingItem) {
        await tx.cartItem.update({
          where: { id: existingItem.id },
          data: { quantity: newQuantity },
        });
      } else {
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId: product.id,
            quantity: input.quantity,
          },
        });
      }

      const updated = await tx.cart.findUnique({
        where: { id: cart.id },
        include: includeItems(),
      });
      return updated as CartWithItems;
    });
  },

  // A cart item id unambiguously belongs to exactly one (buyer, currency)
  // cart via its own cart relation — no currency parameter needed here.
  async updateItem(
    buyerId: string,
    itemId: string,
    input: UpdateCartItemInput,
  ): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const item = await tx.cartItem.findUnique({
        where: { id: itemId },
        include: { product: true, cart: true },
      });
      if (!item || item.cart.buyerId !== buyerId) {
        throw new AppError("Cart item not found", 404);
      }

      assertProductPurchasable(item.product, input.quantity);

      await tx.cartItem.update({
        where: { id: item.id },
        data: { quantity: input.quantity },
      });

      const updated = await tx.cart.findUnique({
        where: { id: item.cartId },
        include: includeItems(),
      });
      return updated as CartWithItems;
    });
  },

  async removeItem(buyerId: string, itemId: string): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const item = await tx.cartItem.findUnique({
        where: { id: itemId },
        include: { cart: true },
      });
      if (!item || item.cart.buyerId !== buyerId) {
        throw new AppError("Cart item not found", 404);
      }

      await tx.cartItem.delete({ where: { id: item.id } });

      const updated = await tx.cart.findUnique({
        where: { id: item.cartId },
        include: includeItems(),
      });
      return updated as CartWithItems;
    });
  },

  // Clears exactly one currency-cart. `currency` is required — there is no
  // "clear everything" call, since each currency-cart is independent.
  async clearCart(buyerId: string, currency: string): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const cart = await getOrCreateCart(buyerId, currency.toUpperCase(), tx);

      if (cart.items.length > 0) {
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      }

      const updated = await tx.cart.findUnique({
        where: { id: cart.id },
        include: includeItems(),
      });
      return updated as CartWithItems;
    });
  },
};
