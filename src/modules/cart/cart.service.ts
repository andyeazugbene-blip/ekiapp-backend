import type { Cart, CartItem, Prisma, Product } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { AddCartItemInput, UpdateCartItemInput } from "./cart.types";

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
  tx: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<CartWithItems> {
  // Use upsert to prevent race condition (unique on buyerId)
  const cart = await tx.cart.upsert({
    where: { buyerId },
    update: {},
    create: { buyerId },
    include: includeItems(),
  });
  return cart as CartWithItems;
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
  async getCart(buyerId: string): Promise<CartWithItems> {
    return getOrCreateCart(buyerId);
  },

  async addItem(buyerId: string, input: AddCartItemInput): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const cart = await getOrCreateCart(buyerId, tx);

      const product = await tx.product.findUnique({ where: { id: input.productId } });
      if (!product) throw new AppError("Product not found", 404);
      if (!product.isActive) throw new AppError("Product is not available", 400);

      // Multi-vendor: no vendor restriction — items from any vendor allowed
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

  async updateItem(
    buyerId: string,
    itemId: string,
    input: UpdateCartItemInput,
  ): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findUnique({ where: { buyerId } });
      if (!cart) throw new AppError("Cart not found", 404);

      const item = await tx.cartItem.findUnique({
        where: { id: itemId },
        include: { product: true },
      });
      if (!item || item.cartId !== cart.id) {
        throw new AppError("Cart item not found", 404);
      }

      assertProductPurchasable(item.product, input.quantity);

      await tx.cartItem.update({
        where: { id: item.id },
        data: { quantity: input.quantity },
      });

      const updated = await tx.cart.findUnique({
        where: { id: cart.id },
        include: includeItems(),
      });
      return updated as CartWithItems;
    });
  },

  async removeItem(buyerId: string, itemId: string): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findUnique({
        where: { buyerId },
        include: { items: true },
      });
      if (!cart) throw new AppError("Cart not found", 404);

      const item = cart.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new AppError("Cart item not found", 404);

      await tx.cartItem.delete({ where: { id: item.id } });

      const updated = await tx.cart.findUnique({
        where: { id: cart.id },
        include: includeItems(),
      });
      return updated as CartWithItems;
    });
  },

  async clearCart(buyerId: string): Promise<CartWithItems> {
    return prisma.$transaction(async (tx) => {
      const cart = await getOrCreateCart(buyerId, tx);

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
