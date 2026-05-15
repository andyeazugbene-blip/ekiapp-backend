import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    orderItem: { findFirst: vi.fn() },
    review: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { reviewsService } from "../modules/reviews/reviews.service";
import { validateCreateReviewInput } from "../modules/reviews/reviews.validation";

const orderFindUnique = prisma.order.findUnique as unknown as ReturnType<typeof vi.fn>;
const orderItemFindFirst = prisma.orderItem.findFirst as unknown as ReturnType<typeof vi.fn>;
const reviewFindFirst = prisma.review.findFirst as unknown as ReturnType<typeof vi.fn>;
const reviewCreate = prisma.review.create as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reviewsService.createReview", () => {
  const validInput = {
    orderId: "order-1",
    vendorId: "vendor-1",
    productId: "product-1",
    rating: 5,
    comment: "Great!",
  };

  it("rejects review when order is not DELIVERED or COMPLETED", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      buyerId: "buyer-1",
      status: "PAID",
      vendorId: "vendor-1",
    });

    await expect(
      reviewsService.createReview("buyer-1", validInput),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects review when buyer does not own the order", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      buyerId: "other-buyer",
      status: "DELIVERED",
      vendorId: "vendor-1",
    });

    await expect(
      reviewsService.createReview("buyer-1", validInput),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects duplicate review", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      buyerId: "buyer-1",
      status: "DELIVERED",
      vendorId: "vendor-1",
    });
    orderItemFindFirst.mockResolvedValue({ id: "item-1" });
    reviewFindFirst.mockResolvedValue({ id: "existing-review" });

    await expect(
      reviewsService.createReview("buyer-1", validInput),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("creates review when all conditions are met", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      buyerId: "buyer-1",
      status: "DELIVERED",
      vendorId: "vendor-1",
    });
    orderItemFindFirst.mockResolvedValue({ id: "item-1" });
    reviewFindFirst.mockResolvedValue(null);
    reviewCreate.mockResolvedValue({
      id: "review-1",
      buyerId: "buyer-1",
      vendorId: "vendor-1",
      productId: "product-1",
      orderId: "order-1",
      rating: 5,
      comment: "Great!",
      status: "PENDING",
      createdAt: new Date(),
    });

    const result = await reviewsService.createReview("buyer-1", validInput);
    expect(result.id).toBe("review-1");
    expect(result.rating).toBe(5);
    expect(reviewCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          buyerId: "buyer-1",
          vendorId: "vendor-1",
          rating: 5,
          status: "PENDING",
        }),
      }),
    );
  });

  it("rejects review when product is not in the order", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      buyerId: "buyer-1",
      status: "DELIVERED",
      vendorId: "vendor-1",
    });
    orderItemFindFirst.mockResolvedValue(null); // product not in order

    await expect(
      reviewsService.createReview("buyer-1", validInput),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects review when order does not exist", async () => {
    orderFindUnique.mockResolvedValue(null);

    await expect(
      reviewsService.createReview("buyer-1", validInput),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Review Validation", () => {
  it("rejects rating below 1", () => {
    expect(() =>
      validateCreateReviewInput({ orderId: "o1", vendorId: "v1", rating: 0 }),
    ).toThrow();
  });

  it("rejects rating above 5", () => {
    expect(() =>
      validateCreateReviewInput({ orderId: "o1", vendorId: "v1", rating: 6 }),
    ).toThrow();
  });

  it("accepts valid review input", () => {
    const result = validateCreateReviewInput({
      orderId: "o1",
      vendorId: "v1",
      rating: 4,
      comment: "Good",
    });
    expect(result.rating).toBe(4);
    expect(result.comment).toBe("Good");
  });
});
