import { AppError } from "../../shared/errors/app-error";
import type { AdminListReviewsQuery, CreateReviewInput, ListReviewsQuery, ModerateReviewInput } from "./reviews.types";

const VALID_STATUSES = new Set(["APPROVED", "HIDDEN", "REJECTED"]);

export function validateCreateReviewInput(input: unknown): CreateReviewInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.orderId !== "string" || !raw.orderId.trim()) {
    throw new AppError("orderId is required", 400);
  }
  if (typeof raw.vendorId !== "string" || !raw.vendorId.trim()) {
    throw new AppError("vendorId is required", 400);
  }
  const rating = Number(raw.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError("rating must be an integer between 1 and 5", 400);
  }

  return {
    orderId: raw.orderId.trim(),
    vendorId: raw.vendorId.trim(),
    productId: typeof raw.productId === "string" && raw.productId.trim() ? raw.productId.trim() : undefined,
    rating,
    comment: typeof raw.comment === "string" && raw.comment.trim() ? raw.comment.trim() : undefined,
  };
}

export function validateListReviewsQuery(query: Record<string, unknown>): ListReviewsQuery {
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  return {
    vendorId: typeof query.vendorId === "string" ? query.vendorId : undefined,
    productId: typeof query.productId === "string" ? query.productId : undefined,
    limit,
    cursor: typeof query.cursor === "string" ? query.cursor : undefined,
  };
}

export function validateAdminListReviewsQuery(query: Record<string, unknown>): AdminListReviewsQuery {
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const status = typeof query.status === "string" && VALID_STATUSES.has(query.status.toUpperCase())
    ? (query.status.toUpperCase() as AdminListReviewsQuery["status"])
    : undefined;
  return {
    status,
    limit,
    cursor: typeof query.cursor === "string" ? query.cursor : undefined,
  };
}

export function validateModerateReviewInput(input: unknown): ModerateReviewInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const status = typeof raw.status === "string" ? raw.status.toUpperCase() : "";
  if (!VALID_STATUSES.has(status)) {
    throw new AppError("status must be APPROVED, HIDDEN, or REJECTED", 400);
  }
  return { status: status as ModerateReviewInput["status"] };
}
