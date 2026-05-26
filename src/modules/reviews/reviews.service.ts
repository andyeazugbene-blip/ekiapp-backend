import type { Review } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type {
  AdminListReviewsQuery,
  CreateReviewInput,
  ListReviewsQuery,
  ModerateReviewInput,
} from "./reviews.types";

interface PublicReview {
  id: string;
  vendorId: string;
  productId: string | null;
  rating: number;
  comment: string | null;
  /** Privacy-preserving display name (e.g. "Jane D."). Round 7 canonical name. */
  buyerDisplayName: string;
  /** @deprecated Round 6 alias of `buyerDisplayName`. Kept for one release. */
  buyerName: string;
  createdAt: Date;
}

interface PublicReviewsResponse {
  items: PublicReview[];
  nextCursor: string | null;
  averageRating: number | null;
  totalReviews: number;
}

/**
 * Convert a buyer's full name into a privacy-preserving display name
 * ("Jane Doe" -> "Jane D."). Empty/short names pass through.
 */
function safeBuyerDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Anonymous";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${first} ${lastInitial}.`;
}

export const reviewsService = {
  /**
   * Create a review. Buyer must own the order, order must be DELIVERED or COMPLETED,
   * and only one review per (buyer, order, product) is allowed.
   */
  async createReview(buyerId: string, input: CreateReviewInput): Promise<Review> {
    // Verify order exists and belongs to buyer
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, buyerId: true, status: true, vendorId: true },
    });
    if (!order) throw new AppError("Order not found", 404);
    if (order.buyerId !== buyerId) throw new AppError("Forbidden", 403);

    // Order must be paid or beyond — accepts the full set of post-payment statuses.
    const reviewableStatuses = new Set([
      "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT",
      "DELIVERED", "COMPLETED", "PAYMENT_SECURED", "VENDOR_CONFIRMED", "AUTO_RELEASED",
    ]);
    if (!reviewableStatuses.has(order.status)) {
      throw new AppError("You can only review after the order has been paid", 400);
    }

    // Verify vendor matches the order
    if (order.vendorId && order.vendorId !== input.vendorId) {
      throw new AppError("Vendor does not match this order", 400);
    }

    // If productId provided, verify it belongs to the order
    if (input.productId) {
      // Verify the product itself exists (404 if it doesn't)
      const product = await prisma.product.findUnique({
        where: { id: input.productId },
        select: { id: true },
      });
      if (!product) throw new AppError("Product not found", 404);

      const orderItem = await prisma.orderItem.findFirst({
        where: { orderId: input.orderId, productId: input.productId },
      });
      if (!orderItem) {
        throw new AppError("Product not found in this order", 400);
      }
    }

    // Check for duplicate review
    const existing = await prisma.review.findFirst({
      where: {
        buyerId,
        orderId: input.orderId,
        productId: input.productId ?? null,
      },
    });
    if (existing) {
      throw new AppError("You have already reviewed this item", 409);
    }

    return prisma.review.create({
      data: {
        buyerId,
        vendorId: input.vendorId,
        productId: input.productId ?? null,
        orderId: input.orderId,
        rating: input.rating,
        comment: input.comment ?? null,
        status: "PENDING",
      },
    });
  },

  /**
   * List approved/visible reviews (public). Filters by vendorId and/or productId.
   * Returns safe buyer display name + summary (averageRating, totalReviews).
   */
  async listPublicReviews(query: ListReviewsQuery): Promise<PublicReviewsResponse> {
    const where = {
      status: "APPROVED" as const,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    };

    const [rawItems, agg, totalReviews] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: CURSOR_ORDER_BY,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      prisma.review.aggregate({ where, _avg: { rating: true } }),
      prisma.review.count({ where }),
    ]);

    let nextCursor: string | null = null;
    let items = rawItems;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    // Hydrate buyer display names in one query (no PII)
    const buyerIds = [...new Set(items.map((r) => r.buyerId))];
    const buyers = buyerIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: buyerIds } },
          select: { id: true, name: true },
        });
    const nameMap = new Map(buyers.map((b) => [b.id, safeBuyerDisplayName(b.name)]));

    const publicItems: PublicReview[] = items.map((r) => {
      const display = nameMap.get(r.buyerId) ?? "Anonymous";
      return {
        id: r.id,
        vendorId: r.vendorId,
        productId: r.productId,
        rating: r.rating,
        comment: r.comment,
        buyerDisplayName: display,
        // Backward-compatible alias used by the existing FE code path.
        buyerName: display,
        createdAt: r.createdAt,
      };
    });

    return {
      items: publicItems,
      nextCursor,
      averageRating: agg._avg.rating,
      totalReviews,
    };
  },

  /**
   * Admin: list all reviews with optional status filter.
   */
  async adminListReviews(
    query: AdminListReviewsQuery,
  ): Promise<{ items: Review[]; nextCursor: string | null }> {
    const items = await prisma.review.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },

  /**
   * Admin: moderate a review (approve/hide/reject).
   */
  async moderateReview(reviewId: string, adminId: string, input: ModerateReviewInput): Promise<Review> {
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new AppError("Review not found", 404);

    return prisma.review.update({
      where: { id: reviewId },
      data: {
        status: input.status,
        moderatedBy: adminId,
        moderatedAt: new Date(),
      },
    });
  },

  /**
   * Get average rating for a vendor (approved reviews only).
   */
  async getVendorAverageRating(vendorId: string): Promise<number | null> {
    const agg = await prisma.review.aggregate({
      where: { vendorId, status: "APPROVED" },
      _avg: { rating: true },
    });
    return agg._avg.rating;
  },

  /**
   * Buyer: list reviews they have authored (any status). Includes vendor + product titles.
   */
  async listMyReviews(buyerId: string, query: { limit: number; cursor?: string }): Promise<{
    items: Array<{
      id: string;
      vendorId: string;
      productId: string | null;
      orderId: string;
      rating: number;
      comment: string | null;
      status: string;
      createdAt: Date;
    }>;
    nextCursor: string | null;
  }> {
    const items = await prisma.review.findMany({
      where: { buyerId },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        vendorId: true,
        productId: true,
        orderId: true,
        rating: true,
        comment: true,
        status: true,
        createdAt: true,
      },
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },
};
