import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    review: { findMany: vi.fn(), groupBy: vi.fn() },
    vendor: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { reviewsService } from "../modules/reviews/reviews.service";
import { validateAdminListReviewsQuery } from "../modules/reviews/reviews.validation";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  m.review.findMany.mockResolvedValue([]);
  m.review.groupBy.mockResolvedValue([]);
  m.vendor.findMany.mockResolvedValue([]);
  m.user.findMany.mockResolvedValue([]);
  m.product.findMany.mockResolvedValue([]);
});

/**
 * Regression coverage: the admin reviews LIST query validator reused the
 * MODERATION-target status set (APPROVED/HIDDEN/REJECTED — you can't
 * moderate a review "to" pending), which meant an admin could never
 * actually filter for PENDING reviews at all: ?status=PENDING was silently
 * dropped by validateAdminListReviewsQuery, always falling back to "no
 * filter." Since new reviews start PENDING, this made the single most
 * useful admin filter (the moderation queue) impossible to query for.
 */
describe("validateAdminListReviewsQuery — PENDING must be a valid filter", () => {
  it("accepts status=PENDING", () => {
    expect(validateAdminListReviewsQuery({ status: "pending" }).status).toBe("PENDING");
  });

  it("still accepts the other three real statuses", () => {
    expect(validateAdminListReviewsQuery({ status: "approved" }).status).toBe("APPROVED");
    expect(validateAdminListReviewsQuery({ status: "hidden" }).status).toBe("HIDDEN");
    expect(validateAdminListReviewsQuery({ status: "rejected" }).status).toBe("REJECTED");
  });

  it("rejects a status that isn't a real ReviewStatus value, falling back to no filter rather than throwing", () => {
    expect(validateAdminListReviewsQuery({ status: "not_a_real_status" }).status).toBeUndefined();
  });

  it("passes through a trimmed, length-capped search string", () => {
    expect(validateAdminListReviewsQuery({ q: "  great product  " }).q).toBe("great product");
    expect(validateAdminListReviewsQuery({ q: "a".repeat(500) }).q?.length).toBe(200);
    expect(validateAdminListReviewsQuery({}).q).toBeUndefined();
  });
});

describe("reviewsService.adminListReviews — real counts and search, no fabricated product title", () => {
  it("queries review.findMany with status=PENDING when asked (the actual bug this closes)", async () => {
    await reviewsService.adminListReviews({ status: "PENDING" as never, limit: 20 });
    expect(m.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "PENDING" }) }),
    );
  });

  it("returns real per-status counts independent of the current page's filter", async () => {
    m.review.groupBy.mockResolvedValue([
      { status: "PENDING", _count: { id: 3 } },
      { status: "APPROVED", _count: { id: 40 } },
      { status: "REJECTED", _count: { id: 2 } },
    ] as never);

    const result = await reviewsService.adminListReviews({ status: "PENDING" as never, limit: 20 });

    expect(result.counts).toEqual({ PENDING: 3, APPROVED: 40, REJECTED: 2 });
  });

  it("applies a real case-insensitive search on the review comment", async () => {
    await reviewsService.adminListReviews({ q: "terrible", limit: 20 });
    expect(m.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ comment: { contains: "terrible", mode: "insensitive" } }] }),
      }),
    );
  });

  it("joins the real product title instead of the old always-null title fallback", async () => {
    m.review.findMany.mockResolvedValue([
      { id: "r1", vendorId: "v1", buyerId: "b1", productId: "p1", rating: 5 },
    ] as never);
    m.product.findMany.mockResolvedValue([{ id: "p1", title: "Real Product Name" }] as never);

    const result = await reviewsService.adminListReviews({ limit: 20 });

    expect(result.items[0].productTitle).toBe("Real Product Name");
  });

  it("a review with no productId gets a null productTitle, not a fabricated placeholder", async () => {
    m.review.findMany.mockResolvedValue([
      { id: "r1", vendorId: "v1", buyerId: "b1", productId: null, rating: 5 },
    ] as never);

    const result = await reviewsService.adminListReviews({ limit: 20 });

    expect(result.items[0].productTitle).toBeNull();
    expect(m.product.findMany).not.toHaveBeenCalled();
  });
});
