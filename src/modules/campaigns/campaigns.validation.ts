import { CampaignDiscountType, CampaignType } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type { CampaignInput } from "./campaigns.types";

export function optionalDiscountType(value: unknown): CampaignDiscountType | null {
  if (value === undefined || value === null || value === "") return null;
  const type = String(value).toUpperCase();
  if (!Object.values(CampaignDiscountType).includes(type as CampaignDiscountType)) {
    throw new AppError(`discountType must be one of: ${Object.values(CampaignDiscountType).join(", ")}`, 400);
  }
  return type as CampaignDiscountType;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required`, 400);
  return value.trim();
}

export function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AppError("Expected string", 400);
  return value.trim() || null;
}

export function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) throw new AppError(`Invalid ${field}`, 400);
  return date.toISOString();
}

export function optionalInt(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new AppError(`Invalid ${field}`, 400);
  return n;
}

export function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new AppError(`${field} must be an array of strings`, 400);
  }
  return value;
}

export function validateCampaignInput(raw: Record<string, unknown>): CampaignInput {
  const type = requiredString(raw.type, "type").toUpperCase();
  if (!Object.values(CampaignType).includes(type as CampaignType)) {
    throw new AppError(`type must be one of: ${Object.values(CampaignType).join(", ")}`, 400);
  }

  const startDate = optionalDate(raw.startDate, "startDate");
  const endDate = optionalDate(raw.endDate, "endDate");
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    throw new AppError("startDate must be before endDate", 400);
  }

  const discountType = optionalDiscountType(raw.discountType);
  const discountValue = optionalInt(raw.discountValue, "discountValue");
  if (discountType && discountValue == null) {
    throw new AppError("discountValue is required when discountType is set", 400);
  }
  if (discountType === "PERCENTAGE" && discountValue != null && discountValue > 100) {
    throw new AppError("discountValue must be 1-100 for a PERCENTAGE discount", 400);
  }

  return {
    name: requiredString(raw.name, "name"),
    type: type as CampaignType,
    active: raw.active === undefined ? true : Boolean(raw.active),
    priority: optionalInt(raw.priority, "priority") ?? 0,
    colorTheme: optionalString(raw.colorTheme),
    title: requiredString(raw.title, "title"),
    subtitle: optionalString(raw.subtitle),
    image: optionalString(raw.image),
    startDate,
    endDate,
    minimumCartAmountCents: optionalInt(raw.minimumCartAmountCents, "minimumCartAmountCents"),
    requiredProductIds: optionalStringArray(raw.requiredProductIds, "requiredProductIds"),
    requiredCategoryIds: optionalStringArray(raw.requiredCategoryIds, "requiredCategoryIds"),
    minimumOrders: optionalInt(raw.minimumOrders, "minimumOrders"),
    minimumSpendCents: optionalInt(raw.minimumSpendCents, "minimumSpendCents"),
    newCustomerOnly: Boolean(raw.newCustomerOnly),
    discountType,
    discountValue,
  };
}
