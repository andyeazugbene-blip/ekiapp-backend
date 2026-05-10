import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { CalculateDeliveryInput, CalculateDeliveryResult } from "./delivery.types";

export const deliveryService = {
  async calculate(
    buyerId: string,
    input: CalculateDeliveryInput,
  ): Promise<CalculateDeliveryResult> {
    const cart = await prisma.cart.findUnique({
      where: { id: input.cartId },
      include: { items: { include: { product: true } } },
    });

    if (!cart) {
      throw new AppError("Cart not found", 404);
    }
    if (cart.buyerId !== buyerId) {
      throw new AppError("Forbidden", 403);
    }
    if (cart.items.length === 0) {
      throw new AppError("Cart is empty", 400);
    }

    const zone = await prisma.deliveryZone.findUnique({
      where: { id: input.destinationZoneId },
    });
    if (!zone || !zone.isActive) {
      throw new AppError("Delivery zone not available", 404);
    }

    let subtotalAmount = 0;
    let totalWeightGrams = 0;
    const currencies = new Set<string>();

    for (const item of cart.items) {
      subtotalAmount += item.product.priceInCents * item.quantity;
      totalWeightGrams += (item.product.weightGrams ?? 0) * item.quantity;
      currencies.add(item.product.currency.toLowerCase());
    }

    if (currencies.size > 1) {
      throw new AppError("Products must use the same currency", 400);
    }

    const cartCurrency = [...currencies][0];
    if (cartCurrency !== zone.currency.toLowerCase()) {
      throw new AppError("Delivery zone currency mismatch", 400);
    }

    const weightKgCeil = Math.ceil(totalWeightGrams / 1000);
    const deliveryAmount = zone.baseFeeAmount + weightKgCeil * zone.feePerKgAmount;
    const totalAmount = subtotalAmount + deliveryAmount;

    return {
      subtotalAmount,
      deliveryAmount,
      totalAmount,
      totalWeightGrams,
      currency: cartCurrency,
    };
  },
};
