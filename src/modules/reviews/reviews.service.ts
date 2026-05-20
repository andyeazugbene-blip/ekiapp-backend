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

    // Order must be delivered or completed
    if (!["DELIVERED", "COMPLETED"].includes(order.status)) {
      throw new AppError("You can only review after the order is delivered", 400);
    }

    // Verify vendor matches the order
    if (order.vendorId && order.vendorId !== input.vendorId) {
      throw new AppError("Vendor does not match this order", 400);
    }

    // If productId provided, verify it belongs to the order
    if (input.productId) {
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
   */
  async listPublicReviews(
    query: ListReviewsQuery,
  ): Promise<{ items: Review[]; nextCursor: string | null; averageRating: number | null }> {
    const where = {
      status: "APPROVED" as const,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    };

    const items = await prisma.review.findMany({
      where,
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    // Compute average rating
    const agg = await prisma.review.aggregate({
      where,
      _avg: { rating: true },
    });

    return { items, nextCursor, averageRating: agg._avg.rating };
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
};
