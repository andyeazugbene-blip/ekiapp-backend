import type { PayoutMethod, Prisma, Vendor } from "@prisma/client";
import { UserRole } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePayoutMethodInput,
  CreateVendorInput,
  UpdateVendorInput,
} from "./vendors.types";

async function ensureWallet(vendorId: string, tx: Prisma.TransactionClient): Promise<void> {
  await tx.wallet.upsert({
    where: { vendorId },
    update: {},
    create: { vendorId, currency: env.defaultCurrency },
  });
}

export const vendorsService = {
  async createVendor(userId: string, input: CreateVendorInput): Promise<Vendor> {
    const existing = await prisma.vendor.findUnique({ where: { userId } });
    if (existing) {
      throw new AppError("Vendor profile already exists", 409);
    }

    return prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          userId,
          storeName: input.storeName,
          description: input.description,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
          country: input.country,
        },
      });

      await ensureWallet(vendor.id, tx);

      // Only promote buyers to vendors; never demote admins or other elevated roles.
      await tx.user.updateMany({
        where: { id: userId, role: UserRole.BUYER },
        data: { role: UserRole.VENDOR },
      });

      return vendor;
    });
  },

  async getOwnVendor(userId: string): Promise<Vendor> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      include: { wallet: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }
    return vendor;
  },

  async updateOwnVendor(userId: string, input: UpdateVendorInput): Promise<Vendor> {
    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }

    return prisma.vendor.update({
      where: { id: vendor.id },
      data: input,
    });
  },

  async createPayoutMethod(
    userId: string,
    input: CreatePayoutMethodInput,
  ): Promise<PayoutMethod> {
    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }

    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.payoutMethod.updateMany({
          where: { vendorId: vendor.id, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.payoutMethod.create({
        data: {
          vendorId: vendor.id,
          type: input.type,
          label: input.label,
          details: input.details as Prisma.InputJsonValue,
          isDefault: input.isDefault ?? false,
        },
      });
    });
  },

  async listPayoutMethods(userId: string): Promise<PayoutMethod[]> {
    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }
    return prisma.payoutMethod.findMany({
      where: { vendorId: vendor.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  },
};
