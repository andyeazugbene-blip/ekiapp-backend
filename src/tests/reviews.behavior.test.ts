/**
 * Behavior tests for the reviews service: validation rules, duplicate guard,
 * authorization, and the public summary shape (averageRating + totalReviews).
 *
 * Service-level tests with prisma mocked. Integration tests for the routes
 * already exist in src/tests/reviews.test.ts (kept untouched).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    orderItem: { findFirst: vi.fn() },
    product: { findUnique: vi.fn() },
    review: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    user: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { reviewsService } from "../modules/reviews/reviews.service";
import { validateCreateReviewInput } from "../modules/reviews/reviews.validation";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Reviews validation — rating boundary", () => {
  const baseBody = { orderId: "o1", vendorId: "v1", productId: "p1" };

  it("accepts integer rating 1..5", () => {
    for (const r of [1, 2, 3, 4, 5]) {
      expect(() => validateCreateReviewInput({ ...baseBody, rating: r })).not.toThrow();
    }
  });

  it("rejects 0", () => {
    expect(() => validateCreateReviewInput({ ...baseBody, rating: 0 })).toThrow("integer");
  });

  it("rejects negative", () => {
    expect(() => validateCreateReviewInput({ ...baseBody, rating: -1 })).toThrow("integer");
  });

  it("rejects 6", () => {
    expect(() => validateCreateReviewInput({ ...baseBody, rating: 6 })).toThrow("integer");
  });

  it("rejects non-integer 3.5", () => {
    expect(() => validateCreateReviewInput({ ...baseBody, rating: 3.5 })).toThrow("integer");
  });
});

describe("reviewsService.createReview", () => {
  const buyerId = "buyer-1";
  const input = { orderId: "o1", vendorId: "v1", productId: "p1", rating: 5, comment: "great" };

  it("404 when order is missing", async () => {
    m.order.findUnique.mockResolvedValue(null);
    await expect(reviewsService.createReview(buyerId, input)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("403 when buyer does not own the order", async () => {
    m.order.findUnique.mockResolvedValue({
      id: "o1",
      buyerId: "someone-else",
      status: "PAID",
      vendorId: "v1",
    } as never);
    await expect(reviewsService.createReview(buyerId, input)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("400 when order is not yet payable (PENDING)", async () => {
    m.order.findUnique.mockResolvedValue({
      id: "o1",
      buyerId,
      status: "PENDING",
      vendorId: "v1",
    } as never);
    await expect(reviewsService.createReview(buyerId, input)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("400 when product is not in the order", async () => {
    m.order.findUnique.mockResolvedValue({
      id: "o1",
      buyerId,
      status: "PAID",
      vendorId: "v1",
    } as never);
    m.product.findUnique.mockResolvedValue({ id: "p1" } as never);
    m.orderItem.findFirst.mockResolvedValue(null);
    await expect(reviewsService.createReview(buyerId, input)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404 when productId does not exist", async () => {
    m.order.findUnique.mockResolvedValue({
      id: "o1",
      buyerId,
      status: "PAID",
      vendorId: "v1",
    } as never);
    m.product.findUnique.mockResolvedValue(null);
    await expect(reviewsService.createReview(buyerId, input)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("409 on duplicate (same buyer + order + product)", async () => {
    m.order.findUnique.mockResolvedValue({
      id: "o1",
      buyerId,
      status: "DELIVERED",
      vendorId: "v1",
    } as never);
    m.product.findUnique.mockResolvedValue({ id: "p1" } as never);
    m.orderItem.findFirst.mockResolvedValue({ id: "oi1" } as never);
    m.review.findFirst.mockResolvedValue({ id: "existing" } as never);
    await expect(reviewsService.createReview(buyerId, input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("creates a review for a paid+owned+matching order", async () => {
    m.order.findUnique.mockResolvedValue({
      id: "o1",
      buyerId,
      status: "PAID",
      vendorId: "v1",
    } as never);
    m.product.findUnique.mockResolvedValue({ id: "p1" } as never);
    m.orderItem.findFirst.mockResolvedValue({ id: "oi1" } as never);
    m.review.findFirst.mockResolvedValue(null);
    m.review.create.mockResolvedValue({
      id: "r1",
      buyerId,
      vendorId: "v1",
      productId: "p1",
      orderId: "o1",
      rating: 5,
      comment: "great",
      status: "PENDING",
    } as never);

    const result = await reviewsService.createReview(buyerId, input);
    expect(result.id).toBe("r1");
    expect(m.review.create).toHaveBeenCalled();
  });
});

describe("reviewsService.listPublicReviews", () => {
  it("returns averageRating + totalReviews + safe buyer name", async () => {
    m.review.findMany.mockResolvedValue([
      { id: "r1", buyerId: "b1", vendorId: "v1", productId: "p1", rating: 5, comment: "ok", createdAt: new Date() },
      { id: "r2", buyerId: "b2", vendorId: "v1", productId: "p1", rating: 4, comment: null, createdAt: new Date() },
    ] as never);
    m.review.aggregate.mockResolvedValue({ _avg: { rating: 4.5 } } as never);
    m.review.count.mockResolvedValue(2 as never);
    m.user.findMany.mockResolvedValue([
      { id: "b1", name: "Jane Doe" },
      { id: "b2", name: "Solo" },
    ] as never);

    const out = await reviewsService.listPublicReviews({ productId: "p1", limit: 20 });
    expect(out.averageRating).toBe(4.5);
    expect(out.totalReviews).toBe(2);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].buyerName).toBe("Jane D.");
    expect(out.items[1].buyerName).toBe("Solo");
    // No PII fields
    expect(out.items[0]).not.toHaveProperty("buyerId");
  });

  it("returns null averageRating + 0 totalReviews when empty", async () => {
    m.review.findMany.mockResolvedValue([] as never);
    m.review.aggregate.mockResolvedValue({ _avg: { rating: null } } as never);
    m.review.count.mockResolvedValue(0 as never);
    m.user.findMany.mockResolvedValue([] as never);

    const out = await reviewsService.listPublicReviews({ vendorId: "v1", limit: 20 });
    expect(out.averageRating).toBeNull();
    expect(out.totalReviews).toBe(0);
    expect(out.items).toEqual([]);
  });
});
