import { PayoutMethodType } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePayoutMethodInput,
  CreateVendorInput,
  UpdateVendorInput,
} from "./vendors.types";

const PAYOUT_METHOD_TYPES = new Set<string>(Object.values(PayoutMethodType));

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function nullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function validateCreateVendorInput(input: unknown): CreateVendorInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  const storeName = optionalString(raw.storeName, "storeName");
  if (!storeName) {
    throw new AppError("storeName is required", 400);
  }

  return {
    storeName,
    description: optionalString(raw.description, "description"),
    contactEmail: optionalString(raw.contactEmail, "contactEmail"),
    contactPhone: optionalString(raw.contactPhone, "contactPhone"),
    country: optionalString(raw.country, "country"),
  };
}

export function validateUpdateVendorInput(input: unknown): UpdateVendorInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  const update: UpdateVendorInput = {};

  if (raw.storeName !== undefined) {
    const storeName = optionalString(raw.storeName, "storeName");
    if (!storeName) {
      throw new AppError("Invalid storeName", 400);
    }
    update.storeName = storeName;
  }

  if (raw.description !== undefined) {
    update.description = nullableString(raw.description, "description");
  }
  if (raw.contactEmail !== undefined) {
    update.contactEmail = nullableString(raw.contactEmail, "contactEmail");
  }
  if (raw.contactPhone !== undefined) {
    update.contactPhone = nullableString(raw.contactPhone, "contactPhone");
  }
  if (raw.country !== undefined) {
    update.country = nullableString(raw.country, "country");
  }
  if (raw.city !== undefined) {
    update.city = nullableString(raw.city, "city");
  }
  if (raw.avatar !== undefined) {
    update.avatar = nullableString(raw.avatar, "avatar");
  }
  if (raw.coverImage !== undefined) {
    update.coverImage = nullableString(raw.coverImage, "coverImage");
  }

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }

  return update;
}

export function validateCreatePayoutMethodInput(input: unknown): CreatePayoutMethodInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.type !== "string" || !PAYOUT_METHOD_TYPES.has(raw.type)) {
    throw new AppError("Invalid payout method type", 400);
  }

  if (!raw.details || typeof raw.details !== "object" || Array.isArray(raw.details)) {
    throw new AppError("Invalid payout method details", 400);
  }

  return {
    type: raw.type as PayoutMethodType,
    label: optionalString(raw.label, "label"),
    details: raw.details as Record<string, unknown>,
    isDefault: raw.isDefault === true,
  };
}
