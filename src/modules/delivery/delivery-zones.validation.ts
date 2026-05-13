import { AppError } from "../../shared/errors/app-error";
import type {
  CreateDeliveryMethodInput,
  CreateDeliveryZoneInput,
  UpdateDeliveryMethodInput,
  UpdateDeliveryZoneInput,
} from "./delivery-zones.types";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(`${field} is required`, 400);
  }
  return value.trim();
}

function nonNegativeInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return num;
}

function positiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return num;
}

export function validateCreateDeliveryZoneInput(input: unknown): CreateDeliveryZoneInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  return {
    name: requiredString(raw.name, "name"),
    country: requiredString(raw.country, "country"),
    flag: typeof raw.flag === "string" && raw.flag.trim().length > 0 ? raw.flag.trim() : undefined,
    baseFeeAmount: nonNegativeInt(raw.baseFeeAmount, "baseFeeAmount"),
    feePerKgAmount: nonNegativeInt(raw.feePerKgAmount, "feePerKgAmount"),
    currency: typeof raw.currency === "string" ? raw.currency.trim().toLowerCase() : undefined,
    isActive: raw.isActive === false ? false : true,
  };
}

export function validateUpdateDeliveryZoneInput(input: unknown): UpdateDeliveryZoneInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const update: UpdateDeliveryZoneInput = {};

  if (raw.name !== undefined) update.name = requiredString(raw.name, "name");
  if (raw.country !== undefined) update.country = requiredString(raw.country, "country");
  if (raw.flag !== undefined) {
    update.flag = raw.flag === null ? null : typeof raw.flag === "string" ? raw.flag.trim() || null : null;
  }
  if (raw.baseFeeAmount !== undefined) update.baseFeeAmount = nonNegativeInt(raw.baseFeeAmount, "baseFeeAmount");
  if (raw.feePerKgAmount !== undefined) update.feePerKgAmount = nonNegativeInt(raw.feePerKgAmount, "feePerKgAmount");
  if (raw.currency !== undefined) {
    update.currency = typeof raw.currency === "string" ? raw.currency.trim().toLowerCase() : undefined;
  }
  if (raw.isActive !== undefined) update.isActive = raw.isActive === true;

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }
  return update;
}

export function validateCreateDeliveryMethodInput(input: unknown): CreateDeliveryMethodInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  return {
    label: requiredString(raw.label, "label"),
    priceAmount: nonNegativeInt(raw.priceAmount, "priceAmount"),
    minDays: positiveInt(raw.minDays, "minDays"),
    maxDays: positiveInt(raw.maxDays, "maxDays"),
    isActive: raw.isActive === false ? false : true,
  };
}

export function validateUpdateDeliveryMethodInput(input: unknown): UpdateDeliveryMethodInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const update: UpdateDeliveryMethodInput = {};

  if (raw.label !== undefined) update.label = requiredString(raw.label, "label");
  if (raw.priceAmount !== undefined) update.priceAmount = nonNegativeInt(raw.priceAmount, "priceAmount");
  if (raw.minDays !== undefined) update.minDays = positiveInt(raw.minDays, "minDays");
  if (raw.maxDays !== undefined) update.maxDays = positiveInt(raw.maxDays, "maxDays");
  if (raw.isActive !== undefined) update.isActive = raw.isActive === true;

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }
  return update;
}
