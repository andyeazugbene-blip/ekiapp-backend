import type { Prisma, PromoCode } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { buildVendorShareUrl } from "../vendors/vendors.service";
import type {
  CreatePromoCodeInput,
  CreateVendorPromoCodeInput,
  PromoValidationResult,
  StoreScopedPromoInput,
  UpdatePromoCodeInput,
  ValidatePromoInput,
  VendorPromoCodeView,
} from "./promos.types";

type PromoVendor = {
  id: string;
  storeSlug: string;
  isSuspended: boolean;
};

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
    vendorId: promo.vendorId,
    storeSlug,
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

async function requireVendorByUserId(userId: string): Promise<PromoVendor> {
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

async function requirePromoVendor(input: StoreScopedPromoInput): Promise<PromoVendor> {
  const vendorId = input.vendorId?.trim();
  const storeSlug = input.storeSlug?.trim().toLowerCase();

  if (!vendorId && !storeSlug) {
    throw new AppError("vendorId or storeSlug is required", 400);
  }

  const vendor = vendorId
    ? await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { id: true, storeSlug: true, isSuspended: true },
      })
    : await prisma.vendor.findUnique({
        where: { storeSlug: storeSlug ?? "" },
        select: { id: true, storeSlug: true, isSuspended: true },
      });

  if (!vendor || vendor.isSuspended) {
    throw new AppError("Store not found", 404);
  }

  return vendor;
}

async function resolvePromoVendorForRedemption(
  context: StoreScopedPromoInput,
  orderId?: string,
): Promise<PromoVendor> {
  if (context.vendorId || context.storeSlug) {
    return requirePromoVendor(context);
  }

  if (orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { vendorId: true },
    });
    if (order?.vendorId) {
      return requirePromoVendor({ vendorId: order.vendorId });
    }
  }

  throw new AppError("vendorId or storeSlug is required", 400);
}

export const promosService = {
  async createPromoCode(input: CreatePromoCodeInput): Promise<PromoCode> {
    const vendor = await requirePromoVendor(input);
    const existing = await prisma.promoCode.findFirst({
      where: { vendorId: vendor.id, code: input.code },
      select: { id: true },
    });
    if (existing) {
      throw new AppError("Promo code already exists for this store", 409);
    }

    return prisma.promoCode.create({
      data: {
        vendorId: vendor.id,
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
    const existing = await prisma.promoCode.findFirst({
      where: { vendorId: vendor.id, code: input.code },
      select: { id: true },
    });
    if (existing) {
      throw new AppError("Promo code already exists for this store", 409);
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
          vendorId: vendor.id,
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
            vendorId: vendor.id,
            storeSlug: vendor.storeSlug,
          } as Prisma.InputJsonValue,
        },
      });

      return createdPromo;
    });

    return toVendorPromoCodeView(promo, metadata, vendor.storeSlug);
  },

  async listVendorPromoCodes(userId: string): Promise<VendorPromoCodeView[]> {
    const vendor = await requireVendorByUserId(userId);

    const [promoCodes, auditLogs] = await Promise.all([
      prisma.promoCode.findMany({
        where: { vendorId: vendor.id },
        orderBy: CURSOR_ORDER_BY,
      }),
      prisma.auditLog.findMany({
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
      }),
    ]);

    const metadataMap = new Map(
      auditLogs
        .filter((log) => Boolean(log.entityId))
        .map((log) => [log.entityId as string, parseVendorPromoMetadata(log.metadata)]),
    );

    return promoCodes.map((promo) =>
      toVendorPromoCodeView(
        promo,
        metadataMap.get(promo.id) ?? { productIds: [], audience: "all" },
        vendor.storeSlug,
      ),
    );
  },

  async deleteVendorPromoCode(userId: string, promoId: string): Promise<void> {
    const vendor = await requireVendorByUserId(userId);
    const promo = await prisma.promoCode.findFirst({
      where: { id: promoId, vendorId: vendor.id },
    });
    if (!promo) {
      throw new AppError("Promo code not found", 404);
    }
    if (promo.usedCount > 0) {
      throw new AppError("Cannot delete a promo code that has been used", 409);
    }
    await prisma.promoCode.delete({ where: { id: promoId } });
  },

  async listPublicDeals(): Promise<{
    bundles: Array<{ id: string; vendorId: string; code: string; value: number; type: string; storeName: string; productIds: string[] }>;
    flashSales: Array<{ id: string; vendorId: string; code: string; value: number; type: string; storeName: string; productId: string; endsAt: string | null }>;
  }> {
    const now = new Date();
    const promos = await prisma.promoCode.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gte: now } }],
        code: { startsWith: "BUNDLE" },
      },
      include: { vendor: { select: { storeName: true } } },
      orderBy: CURSOR_ORDER_BY,
    });

    const flashPromos = await prisma.promoCode.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gte: now } }],
        code: { startsWith: "FLASH" },
      },
      include: { vendor: { select: { storeName: true } } },
      orderBy: CURSOR_ORDER_BY,
    });

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entityType: "PROMO_CODE",
        action: "vendor.promo.created",
        entityId: { in: [...promos, ...flashPromos].map((p) => p.id) },
      },
      select: { entityId: true, metadata: true },
    });
    const metaMap = new Map(
      auditLogs.filter((l) => l.entityId).map((l) => [l.entityId!, parseVendorPromoMetadata(l.metadata)]),
    );

    return {
      bundles: promos.map((p) => ({
        id: p.id,
        vendorId: p.vendorId,
        code: p.code,
        value: p.value,
        type: p.type,
        storeName: p.vendor.storeName,
        productIds: metaMap.get(p.id)?.productIds ?? [],
      })),
      flashSales: flashPromos.map((p) => ({
        id: p.id,
        vendorId: p.vendorId,
        code: p.code,
        value: p.value,
        type: p.type,
        storeName: p.vendor.storeName,
        productId: (metaMap.get(p.id)?.productIds ?? [])[0] ?? "",
        endsAt: p.validUntil?.toISOString() ?? null,
      })),
    };
  },

  async validatePromo(
    buyerId: string,
    input: ValidatePromoInput,
  ): Promise<PromoValidationResult> {
    const vendor = await requirePromoVendor(input);
    const promo = await prisma.promoCode.findFirst({
      where: { vendorId: vendor.id, code: input.code },
    });

    if (!promo || !promo.isActive) {
      throw new AppError("Invalid promo code for this store", 400);
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
      vendorId: vendor.id,
      storeSlug: vendor.storeSlug,
    };
  },

  async redeemPromo(
    buyerId: string,
    code: string,
    orderAmount: number,
    orderId?: string,
    context: StoreScopedPromoInput = {},
  ): Promise<number> {
    const vendor = await resolvePromoVendorForRedemption(context, orderId);
    const result = await this.validatePromo(buyerId, { code, orderAmount, vendorId: vendor.id });

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
          AND "vendorId" = ${vendor.id}
          AND "isActive" = true
          AND "validFrom" <= ${now}
          AND ("validUntil" IS NULL OR "validUntil" >= ${now})
          AND ("maxUses" IS NULL OR "usedCount" < "maxUses")
      `;

      if (rows !== 1) {
        throw new AppError("Promo no longer available", 409);
      }

      const promo = await tx.promoCode.findFirstOrThrow({
        where: { code, vendorId: vendor.id },
      });

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
