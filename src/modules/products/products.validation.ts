import { AppError } from "../../shared/errors/app-error";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "./products.types";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return value.trim();
}

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

function nullableNonNegativeInt(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return nonNegativeInt(value, field);
}

function imagesArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError("Invalid images", 400);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new AppError(`Invalid image at index ${index}`, 400);
    }
    return item.trim();
  });
}

export function validateCreateProductInput(input: unknown): CreateProductInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  return {
    title: requiredString(raw.title, "title"),
    description: optionalString(raw.description, "description"),
    priceAmount: positiveInt(raw.priceAmount, "priceAmount"),
    costAmount:
      raw.costAmount === undefined ? undefined : nonNegativeInt(raw.costAmount, "costAmount"),
    costCurrency: optionalString(raw.costCurrency, "costCurrency")?.toUpperCase(),
    currency: optionalString(raw.currency, "currency")?.toLowerCase(),
    images: raw.images === undefined ? undefined : imagesArray(raw.images),
    category: optionalString(raw.category, "category"),
    stock: raw.stock === undefined ? undefined : nonNegativeInt(raw.stock, "stock"),
    weightGrams:
      raw.weightGrams === undefined ? undefined : nonNegativeInt(raw.weightGrams, "weightGrams"),
  };
}

export function validateUpdateProductInput(input: unknown): UpdateProductInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const update: UpdateProductInput = {};

  if (raw.title !== undefined) update.title = requiredString(raw.title, "title");
  if (raw.description !== undefined) {
    update.description = nullableString(raw.description, "description");
  }
  if (raw.priceAmount !== undefined) {
    update.priceAmount = positiveInt(raw.priceAmount, "priceAmount");
  }
  if (raw.costAmount !== undefined) {
    update.costAmount = nullableNonNegativeInt(raw.costAmount, "costAmount");
  }
  if (raw.costCurrency !== undefined) {
    update.costCurrency =
      raw.costCurrency === null ? null : optionalString(raw.costCurrency, "costCurrency")?.toUpperCase() ?? null;
  }
  if (raw.currency !== undefined) {
    const currency = optionalString(raw.currency, "currency");
    if (!currency) throw new AppError("Invalid currency", 400);
    update.currency = currency.toLowerCase();
  }
  if (raw.images !== undefined) update.images = imagesArray(raw.images);
  if (raw.category !== undefined) {
    update.category = nullableString(raw.category, "category");
  }
  if (raw.stock !== undefined) update.stock = nonNegativeInt(raw.stock, "stock");
  if (raw.weightGrams !== undefined) {
    update.weightGrams =
      raw.weightGrams === null ? null : nonNegativeInt(raw.weightGrams, "weightGrams");
  }
  // `isActive` is intentionally NOT vendor-editable. Vendors disable a product
  // via DELETE /products/:id; only admins can re-enable via /admin/products/:id/approve.
  // Allowing vendor PATCH would let them silently undo admin moderation.
  if (raw.isActive !== undefined) {
    throw new AppError("isActive cannot be modified here", 403);
  }

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }

  return update;
}

export function validateListProductsQuery(query: Record<string, unknown>): ListProductsQuery {
  const rawLimit = query.limit;
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }

  return {
    category: optionalString(query.category, "category"),
    vendorId: optionalString(query.vendorId, "vendorId"),
    limit,
    cursor: optionalString(query.cursor, "cursor"),
  };
}
