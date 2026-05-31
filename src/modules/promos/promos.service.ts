import type { PromoCode, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { buildVendorShareUrl } from "../vendors/vendors.service";
import type {
  CreatePromoCodeInput,
  CreateVendorPromoCodeInput,
  PromoValidationResult,
  UpdatePromoCodeInput,
  ValidatePromoInput,
  VendorPromoCodeView,
} from "./promos.types";

type VendorPromoMetadata = {
  productIds: string[];
  audience: CreateVendorPromoCodeInput["audience"];
  audienceCountry?: string;
  shareUrl?: string;
};

function parseVendorPromoMetadata(metadata: Prisma.JsonValue | null): VendorPromoMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      productIds: [],
      audience: "all",
    };
  }

  const raw = metadata as Record<string, unknown>;
  const audience = typeof raw.audience === "string" ? raw.audience.trim().toLowerCase() : "all";

  return {
    productIds: Array.isArray(raw.productIds)
      ? raw.productIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
    audience: ["all", "repeat", "new", "country"].includes(audience)
      ? (audience as CreateVendorPromoCodeInput["audience"])
      : "all",
    audienceCountry:
      typeof raw.audienceCountry === "string" && raw.audienceCountry.trim().length > 0
        ? raw.audienceCountry.trim()
        : undefined,
    shareUrl:
      typeof raw.shareUrl === "string" && raw.shareUrl.trim().length > 0
        ? raw.shareUrl.trim()
        : undefined,
  };
}

function buildVendorPromoShareUrl(storeSlug: string, code: string, productId?: string): string {
  const baseUrl = buildVendorShareUrl(storeSlug);
  const params = new URLSearchParams({ promo: code });
  if (productId) {
    params.set("product", productId);
  }
  return `${baseUrl}?${params.toString()}`;
}

function toVendorPromoCodeView(
  promo: PromoCode,
  metadata: VendorPromoMetadata,
  storeSlug: string,
): VendorPromoCodeView {
  const preferredProductId = metadata.productIds.length === 1 ? metadata.productIds[0] : undefined;

  return {
    id: promo.id,
    code: promo.code,
    type: promo.type,
    value: promo.value,
    minOrderAmount: promo.minOrderAmount,
    maxUses: promo.maxUses,
    usedCount: promo.usedCount,
    isActive: promo.isActive,
    validFrom: promo.validFrom.toISOString(),
    validUntil: promo.validUntil ? promo.validUntil.toISOString() : null,
    createdAt: promo.createdAt.toISOString(),
    productIds: metadata.productIds,
    audience: metadata.audience,
    audienceCountry: metadata.audienceCountry,
    shareUrl: metadata.shareUrl ?? buildVendorPromoShareUrl(storeSlug, promo.code, preferredProductId),
  };
}

async function requireVendorByUserId(userId: string): Promise<{ id: string; storeSlug: string; isSuspended: boolean }> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: {
      id: true,
      storeSlug: true,
      isSuspended: true,
    },
  });

  if (!vendor || vendor.isSuspended) {
    throw new AppError("Vendor profile not found", 404);
  }

  return vendor;
}

export const promosService = {
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

  async createVendorPromoCode(userId: string, input: CreateVendorPromoCodeInput): Promise<VendorPromoCodeView> {
    const vendor = await requireVendorByUserId(userId);
    const existing = await prisma.promoCode.findUnique({ where: { code: input.code } });
    if (existing) {
      throw new AppError("Promo code already exists", 409);
    }

    const productIds = Array.from(new Set(input.productIds));
    if (productIds.length > 0) {
      const ownedProducts = await prisma.product.findMany({
        where: {
          vendorId: vendor.id,
          id: { in: productIds },
        },
        select: { id: true },
      });

      if (ownedProducts.length !== productIds.length) {
        throw new AppError("One or more selected products do not belong to this store", 400);
      }
    }

    const shareUrl = buildVendorPromoShareUrl(
      vendor.storeSlug,
      input.code,
      productIds.length === 1 ? productIds[0] : undefined,
    );

    const metadata: VendorPromoMetadata = {
      productIds,
      audience: input.audience,
      audienceCountry: input.audienceCountry,
      shareUrl,
    };

    const promo = await prisma.$transaction(async (tx) => {
      const createdPromo = await tx.promoCode.create({
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

      await tx.auditLog.create({
        data: {
          actorId: vendor.id,
          action: "vendor.promo.created",
          entityType: "PROMO_CODE",
          entityId: createdPromo.id,
          metadata: {
            productIds,
            audience: input.audience,
            audienceCountry: input.audienceCountry ?? null,
            shareUrl,
          } as Prisma.InputJsonValue,
        },
      });

      return createdPromo;
    });

    return toVendorPromoCodeView(promo, metadata, vendor.storeSlug);
  },

  async listVendorPromoCodes(userId: string): Promise<VendorPromoCodeView[]> {
    const vendor = await requireVendorByUserId(userId);

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        actorId: vendor.id,
        entityType: "PROMO_CODE",
        action: "vendor.promo.created",
        entityId: { not: null },
      },
      orderBy: CURSOR_ORDER_BY,
      select: {
        entityId: true,
        metadata: true,
      },
    });

    const promoIds = auditLogs
      .map((log) => log.entityId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    if (promoIds.length === 0) {
      return [];
    }

    const promoCodes = await prisma.promoCode.findMany({
      where: {
        id: { in: promoIds },
      },
    });

    const promoMap = new Map(promoCodes.map((promo) => [promo.id, promo]));

    return auditLogs
      .map((log) => {
        if (!log.entityId) return null;
        const promo = promoMap.get(log.entityId);
        if (!promo) return null;
        return toVendorPromoCodeView(
          promo,
          parseVendorPromoMetadata(log.metadata),
          vendor.storeSlug,
        );
      })
      .filter((promo): promo is VendorPromoCodeView => Boolean(promo));
  },

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
      throw new AppError(`Minimum order amount is ${promo.minOrderAmount} cents`, 400);
    }

    const existingRedemption = await prisma.promoRedemption.findUnique({
      where: { promoCodeId_buyerId: { promoCodeId: promo.id, buyerId } },
    });
    if (existingRedemption) {
      throw new AppError("You have already used this promo code", 400);
    }

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

    const now = new Date();
    return prisma.$transaction(async (tx) => {
      if (orderId) {
        const existingRedemption = await tx.promoRedemption.findFirst({
          where: { orderId, buyerId },
          select: { id: true },
        });
        if (existingRedemption) {
          throw new AppError("Only one promo code can be applied per order", 409);
        }
      }

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
