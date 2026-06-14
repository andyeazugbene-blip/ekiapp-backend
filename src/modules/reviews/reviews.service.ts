import type { Prisma, Review } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type { AdminListReviewsQuery, CreateReviewInput, ListReviewsQuery, ModerateReviewInput } from "./reviews.types";

interface PublicReview {
  id: string; vendorId: string; productId: string | null;
  rating: number; comment: string | null;
  buyerDisplayName: string; buyerName: string;
  createdAt: Date;
}
interface PublicReviewsResponse { items: PublicReview[]; nextCursor: string | null; averageRating: number | null; totalReviews: number; }

function safeBuyerDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Anonymous";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

export const reviewsService = {
  async createReview(buyerId: string, input: CreateReviewInput): Promise<Review> {
    const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, buyerId: true, status: true, vendorId: true } });
    if (!order) throw new AppError("Order not found", 404);
    if (order.buyerId !== buyerId) throw new AppError("Forbidden", 403);
    const reviewable = new Set(["PAID","CONFIRMED","PROCESSING","DISPATCHED","IN_TRANSIT","DELIVERED","COMPLETED","PAYMENT_SECURED","VENDOR_CONFIRMED","AUTO_RELEASED"]);
    if (!reviewable.has(order.status)) throw new AppError("Order not yet reviewable", 400);
    if (order.vendorId && order.vendorId !== input.vendorId) throw new AppError("Vendor mismatch", 400);
    if (input.productId) {
      if (!(await prisma.product.findUnique({ where: { id: input.productId } }))) throw new AppError("Product not found", 404);
      if (!(await prisma.orderItem.findFirst({ where: { orderId: input.orderId, productId: input.productId } }))) throw new AppError("Product not in order", 400);
    }
    const existing = await prisma.review.findFirst({ where: { buyerId, orderId: input.orderId, productId: input.productId ?? null } });
    if (existing) throw new AppError("Already reviewed", 409);
    return prisma.review.create({ data: { buyerId, vendorId: input.vendorId, productId: input.productId ?? null, orderId: input.orderId, rating: input.rating, comment: input.comment ?? null, status: "PENDING" } });
  },

  async listPublicReviews(query: ListReviewsQuery): Promise<PublicReviewsResponse> {
    const where = { status: "APPROVED" as const, ...(query.vendorId ? { vendorId: query.vendorId } : {}), ...(query.productId ? { productId: query.productId } : {}) };
    const [rawItems, agg, totalReviews] = await Promise.all([
      prisma.review.findMany({ where, orderBy: CURSOR_ORDER_BY, take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) }),
      prisma.review.aggregate({ where, _avg: { rating: true } }),
      prisma.review.count({ where }),
    ]);
    let nextCursor: string | null = null;
    let items = rawItems;
    if (items.length > query.limit) { const next = items.pop(); nextCursor = next?.id ?? null; }
    const buyerIds = [...new Set(items.map(r => r.buyerId))];
    const buyers = buyerIds.length === 0 ? [] : await prisma.user.findMany({ where: { id: { in: buyerIds } }, select: { id: true, name: true } });
    const nameMap = new Map(buyers.map(b => [b.id, safeBuyerDisplayName(b.name)]));
    return { items: items.map((r: any) => ({ id: r.id, vendorId: r.vendorId, productId: r.productId, rating: r.rating, comment: r.comment, buyerDisplayName: nameMap.get(r.buyerId) ?? "Anonymous", buyerName: nameMap.get(r.buyerId) ?? "Anonymous", createdAt: r.createdAt })), nextCursor, averageRating: agg._avg.rating, totalReviews };
  },

  async adminListReviews(query: AdminListReviewsQuery): Promise<{ items: any[]; nextCursor: string | null }> {
    const items = await prisma.review.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: CURSOR_ORDER_BY, take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (items.length > query.limit) { const next = items.pop(); nextCursor = next?.id ?? null; }
    return { items: items.map((r: any) => ({ ...r, vendorName: (r as any).vendor?.storeName ?? null, buyerName: (r as any).buyer?.name ?? null })), nextCursor };
  },

  async moderateReview(reviewId: string, adminId: string, input: ModerateReviewInput): Promise<Review> {
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new AppError("Review not found", 404);
    return prisma.review.update({ where: { id: reviewId }, data: { status: input.status, moderatedBy: adminId, moderatedAt: new Date() } });
  },

  async getVendorAverageRating(vendorId: string): Promise<number | null> {
    const agg = await prisma.review.aggregate({ where: { vendorId, status: "APPROVED" }, _avg: { rating: true } });
    return agg._avg.rating;
  },

  async listMyReviews(buyerId: string, query: { limit: number; cursor?: string }): Promise<{ items: Array<{ id: string; vendorId: string; productId: string | null; orderId: string; rating: number; comment: string | null; status: string; createdAt: Date }>; nextCursor: string | null }> {
    const items = await prisma.review.findMany({ where: { buyerId }, orderBy: CURSOR_ORDER_BY, take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}), select: { id: true, vendorId: true, productId: true, orderId: true, rating: true, comment: true, status: true, createdAt: true } });
    let nextCursor: string | null = null;
    if (items.length > query.limit) { const next = items.pop(); nextCursor = next?.id ?? null; }
    return { items, nextCursor };
  },
};
