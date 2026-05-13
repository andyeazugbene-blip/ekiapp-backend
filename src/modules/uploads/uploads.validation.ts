import { AppError } from "../../shared/errors/app-error";
import type { RequestUploadInput, UploadCategory } from "./uploads.types";

const ALLOWED_CATEGORIES: Set<string> = new Set(["product", "avatar", "cover", "verification"]);

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const ALLOWED_DOC_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

export function validateRequestUploadInput(input: unknown): RequestUploadInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.filename !== "string" || raw.filename.trim().length === 0) {
    throw new AppError("Invalid filename", 400);
  }

  if (typeof raw.contentType !== "string" || raw.contentType.trim().length === 0) {
    throw new AppError("Invalid contentType", 400);
  }

  if (typeof raw.category !== "string" || !ALLOWED_CATEGORIES.has(raw.category)) {
    throw new AppError("Invalid category (product, avatar, cover, verification)", 400);
  }

  const category = raw.category as UploadCategory;
  const contentType = raw.contentType.trim().toLowerCase();

  // Validate content type based on category
  if (category === "verification") {
    if (!ALLOWED_DOC_TYPES.has(contentType)) {
      throw new AppError("Verification documents must be JPEG, PNG, WebP, or PDF", 400);
    }
  } else {
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new AppError("Images must be JPEG, PNG, WebP, or GIF", 400);
    }
  }

  return {
    filename: raw.filename.trim(),
    contentType,
    category,
  };
}
