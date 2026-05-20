import type { BuyerAddress } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type { CreateAddressInput, UpdateAddressInput } from "./addresses.types";

export const addressesService = {
  async list(buyerId: string): Promise<BuyerAddress[]> {
    return prisma.buyerAddress.findMany({
      where: { buyerId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
  },

  async create(buyerId: string, input: CreateAddressInput): Promise<BuyerAddress> {
    return prisma.$transaction(async (tx) => {
      // If this is set as default, unset other defaults
      if (input.isDefault) {
        await tx.buyerAddress.updateMany({
          where: { buyerId, isDefault: true },
          data: { isDefault: false },
        });
      }

      // If this is the first address, make it default
      const count = await tx.buyerAddress.count({ where: { buyerId } });
      const isDefault = input.isDefault || count === 0;

      return tx.buyerAddress.create({
        data: {
          buyerId,
          recipientName: input.recipientName,
          line1: input.line1,
          line2: input.line2,
          city: input.city,
          postalCode: input.postalCode,
          country: input.country,
          phone: input.phone,
          isDefault,
        },
      });
    });
  },

  async update(buyerId: string, addressId: string, input: UpdateAddressInput): Promise<BuyerAddress> {
    const address = await prisma.buyerAddress.findUnique({ where: { id: addressId } });
    if (!address) {
      throw new AppError("Address not found", 404);
    }
    if (address.buyerId !== buyerId) {
      throw new AppError("Forbidden", 403);
    }

    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.buyerAddress.updateMany({
          where: { buyerId, isDefault: true, id: { not: addressId } },
          data: { isDefault: false },
        });
      }

      return tx.buyerAddress.update({
        where: { id: addressId },
        data: input,
      });
    });
  },

  async delete(buyerId: string, addressId: string): Promise<void> {
    const address = await prisma.buyerAddress.findUnique({ where: { id: addressId } });
    if (!address) {
      throw new AppError("Address not found", 404);
    }
    if (address.buyerId !== buyerId) {
      throw new AppError("Forbidden", 403);
    }

    await prisma.buyerAddress.delete({ where: { id: addressId } });

    // If deleted address was default, promote the most recent one
    if (address.isDefault) {
      const next = await prisma.buyerAddress.findFirst({
        where: { buyerId },
        orderBy: CURSOR_ORDER_BY,
      });
      if (next) {
        await prisma.buyerAddress.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
  },
};
