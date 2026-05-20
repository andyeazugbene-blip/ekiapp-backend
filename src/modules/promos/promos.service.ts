import type { PromoCode } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePromoCodeInput,
  PromoValidationResult,
  UpdatePromoCodeInput,
  ValidatePromoInput,
} from "./promos.types";

export const promosService = {
  // ─── Admin ─────────────────────────────────────────────────────────────────

  async createPromoCode(input: CreatePromoCodeInput): Promise<PromoCode> {
    const existing = await prisma.promoCode.findUnique({ where: { code: input.code } });
    if (existing) {
      throw new AppError("Promo code already exists", 409);
    }

    return prisma.promoCode.create({
      data: {
        code: input.code,
        type: input.type,
        value: input.value,
        minOrderAmount: input.minOrderAmount,
        maxUses: input.maxUses,
        validFrom: input.validFrom ? new Date(input.validFrom) : new Date(),
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
      },
    });
  },

  async listPromoCodes(): Promise<PromoCode[]> {
    return prisma.promoCode.findMany({
      orderBy: CURSOR_ORDER_BY,
    });
  },

  async updatePromoCode(promoId: string, input: UpdatePromoCodeInput): Promise<PromoCode> {
    const promo = await prisma.promoCode.findUnique({ where: { id: promoId } });
    if (!promo) {
      throw new AppError("Promo code not found", 404);
    }

    const data: Record<string, unknown> = {};
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.maxUses !== undefined) data.maxUses = input.maxUses;
    if (input.validUntil !== undefined) {
      data.validUntil = input.validUntil ? new Date(input.validUntil) : null;
    }

    return prisma.promoCode.update({ where: { id: promoId }, data });
  },

  // ─── Buyer ─────────────────────────────────────────────────────────────────

  async validatePromo(
    buyerId: string,
    input: ValidatePromoInput,
  ): Promise<PromoValidationResult> {
    const promo = await prisma.promoCode.findUnique({ where: { code: input.code } });

    if (!promo || !promo.isActive) {
      throw new AppError("Invalid promo code", 400);
    }

    const now = new Date();
    if (promo.validFrom > now) {
      throw new AppError("Promo code is not yet active", 400);
    }
    if (promo.validUntil && promo.validUntil < now) {
      throw new AppError("Promo code has expired", 400);
    }
    if (promo.maxUses && promo.usedCount >= promo.maxUses) {
      throw new AppError("Promo code usage limit reached", 400);
    }
    if (promo.minOrderAmount && input.orderAmount < promo.minOrderAmount) {
      throw new AppError(
        `Minimum order amount is ${promo.minOrderAmount} cents`,
        400,
      );
    }

    // Check if buyer already used this code
    const existingRedemption = await prisma.promoRedemption.findUnique({
      where: { promoCodeId_buyerId: { promoCodeId: promo.id, buyerId } },
    });
    if (existingRedemption) {
      throw new AppError("You have already used this promo code", 400);
    }

    // Calculate discount
    let discountAmount: number;
    if (promo.type === "PERCENTAGE") {
      discountAmount = Math.round((input.orderAmount * promo.value) / 100);
    } else {
      discountAmount = Math.min(promo.value, input.orderAmount);
    }

    return {
      valid: true,
      discountAmount,
      code: promo.code,
      type: promo.type,
      value: promo.value,
    };
  },

  async redeemPromo(
    buyerId: string,
    code: string,
    orderAmount: number,
    orderId?: string,
  ): Promise<number> {
    const result = await this.validatePromo(buyerId, { code, orderAmount });

    // Atomic: raw SQL for field-to-field compare (usedCount < maxUses)
    // prevents concurrent over-redemption
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      // One promo per order policy: prevent stacking multiple promos on the same order
      if (orderId) {
        const existingRedemption = await tx.promoRedemption.findFirst({
          where: { orderId, buyerId },
          select: { id: true },
        });
        if (existingRedemption) {
          throw new AppError("Only one promo code can be applied per order", 409);
        }
      }

      // Atomically increment usedCount only if all conditions hold
      const rows: number = await tx.$executeRaw`
        UPDATE "PromoCode"
        SET "usedCount" = "usedCount" + 1, "updatedAt" = NOW()
        WHERE "code" = ${code}
          AND "isActive" = true
          AND "validFrom" <= ${now}
          AND ("validUntil" IS NULL OR "validUntil" >= ${now})
          AND ("maxUses" IS NULL OR "usedCount" < "maxUses")
      `;

      if (rows !== 1) {
        throw new AppError("Promo no longer available", 409);
      }

      const promo = await tx.promoCode.findUniqueOrThrow({ where: { code } });

      await tx.promoRedemption.create({
        data: {
          promoCodeId: promo.id,
          buyerId,
          orderId,
          discountAmount: result.discountAmount,
        },
      });

      return result.discountAmount;
    });
  },
};
