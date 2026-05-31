import { PromoType } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePromoCodeInput,
  CreateVendorPromoCodeInput,
  UpdatePromoCodeInput,
  ValidatePromoInput,
} from "./promos.types";

const PROMO_TYPES = new Set<string>(Object.values(PromoType));

export function validateCreatePromoCodeInput(input: unknown): CreatePromoCodeInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
    throw new AppError("code is required", 400);
  }

  if (typeof raw.type !== "string" || !PROMO_TYPES.has(raw.type)) {
    throw new AppError("type must be PERCENTAGE or FIXED_AMOUNT", 400);
  }

  const value = Number(raw.value);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("value must be a positive integer", 400);
  }

  if (raw.type === "PERCENTAGE" && value > 100) {
    throw new AppError("Percentage value cannot exceed 100", 400);
  }

  let minOrderAmount: number | undefined;
  if (raw.minOrderAmount !== undefined) {
    const v = Number(raw.minOrderAmount);
    if (!Number.isInteger(v) || v < 0) throw new AppError("Invalid minOrderAmount", 400);
    minOrderAmount = v;
  }

  let maxUses: number | undefined;
  if (raw.maxUses !== undefined) {
    const v = Number(raw.maxUses);
    if (!Number.isInteger(v) || v <= 0) throw new AppError("Invalid maxUses", 400);
    maxUses = v;
  }

  let validFrom: string | undefined;
  if (typeof raw.validFrom === "string" && raw.validFrom.length > 0) {
    const d = new Date(raw.validFrom);
    if (isNaN(d.getTime())) throw new AppError("Invalid validFrom date", 400);
    validFrom = d.toISOString();
  }

  let validUntil: string | undefined;
  if (typeof raw.validUntil === "string" && raw.validUntil.length > 0) {
    const d = new Date(raw.validUntil);
    if (isNaN(d.getTime())) throw new AppError("Invalid validUntil date", 400);
    validUntil = d.toISOString();
  }

  return {
    code: raw.code.trim().toUpperCase(),
    type: raw.type as PromoType,
    value,
    minOrderAmount,
    maxUses,
    validFrom,
    validUntil,
  };
}

export function validateUpdatePromoCodeInput(input: unknown): UpdatePromoCodeInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const update: UpdatePromoCodeInput = {};

  if (raw.isActive !== undefined) {
    update.isActive = raw.isActive === true;
  }
  if (raw.maxUses !== undefined) {
    const v = Number(raw.maxUses);
    if (!Number.isInteger(v) || v <= 0) throw new AppError("Invalid maxUses", 400);
    update.maxUses = v;
  }
  if (raw.validUntil !== undefined) {
    if (raw.validUntil === null) {
      update.validUntil = null;
    } else if (typeof raw.validUntil === "string") {
      const d = new Date(raw.validUntil);
      if (isNaN(d.getTime())) throw new AppError("Invalid validUntil date", 400);
      update.validUntil = d.toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }
  return update;
}

export function validateValidatePromoInput(input: unknown): ValidatePromoInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
    throw new AppError("code is required", 400);
  }

  const orderAmount = Number(raw.orderAmount);
  if (!Number.isInteger(orderAmount) || orderAmount <= 0) {
    throw new AppError("orderAmount must be a positive integer (cents)", 400);
  }

  return { code: raw.code.trim().toUpperCase(), orderAmount };
}

export function validateCreateVendorPromoCodeInput(input: unknown): CreateVendorPromoCodeInput {
  const base = validateCreatePromoCodeInput(input);
  const raw = input as Record<string, unknown>;

  const audience = typeof raw.audience === "string" ? raw.audience.trim().toLowerCase() : "all";
  if (!["all", "repeat", "new", "country"].includes(audience)) {
    throw new AppError("Invalid audience", 400);
  }

  const productIds = Array.isArray(raw.productIds)
    ? raw.productIds
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];

  const audienceCountry =
    typeof raw.audienceCountry === "string" && raw.audienceCountry.trim().length > 0
      ? raw.audienceCountry.trim()
      : undefined;

  return {
    ...base,
    productIds,
    audience: audience as CreateVendorPromoCodeInput["audience"],
    audienceCountry,
  };
}
