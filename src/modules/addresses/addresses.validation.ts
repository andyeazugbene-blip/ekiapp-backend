import { AppError } from "../../shared/errors/app-error";
import type { CreateAddressInput, UpdateAddressInput } from "./addresses.types";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(`${field} is required`, 400);
  }
  return value.trim();
}

export function validateCreateAddressInput(input: unknown): CreateAddressInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  return {
    recipientName: requiredString(raw.recipientName, "recipientName"),
    line1: requiredString(raw.line1, "line1"),
    line2: typeof raw.line2 === "string" && raw.line2.trim().length > 0 ? raw.line2.trim() : undefined,
    city: requiredString(raw.city, "city"),
    postalCode: requiredString(raw.postalCode, "postalCode"),
    country: requiredString(raw.country, "country"),
    phone: typeof raw.phone === "string" && raw.phone.trim().length > 0 ? raw.phone.trim() : undefined,
    isDefault: raw.isDefault === true,
  };
}

export function validateUpdateAddressInput(input: unknown): UpdateAddressInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const update: UpdateAddressInput = {};

  if (raw.recipientName !== undefined) {
    update.recipientName = requiredString(raw.recipientName, "recipientName");
  }
  if (raw.line1 !== undefined) {
    update.line1 = requiredString(raw.line1, "line1");
  }
  if (raw.line2 !== undefined) {
    update.line2 = raw.line2 === null ? null : typeof raw.line2 === "string" ? raw.line2.trim() || null : null;
  }
  if (raw.city !== undefined) {
    update.city = requiredString(raw.city, "city");
  }
  if (raw.postalCode !== undefined) {
    update.postalCode = requiredString(raw.postalCode, "postalCode");
  }
  if (raw.country !== undefined) {
    update.country = requiredString(raw.country, "country");
  }
  if (raw.phone !== undefined) {
    update.phone = raw.phone === null ? null : typeof raw.phone === "string" ? raw.phone.trim() || null : null;
  }
  if (raw.isDefault !== undefined) {
    update.isDefault = raw.isDefault === true;
  }

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }

  return update;
}
