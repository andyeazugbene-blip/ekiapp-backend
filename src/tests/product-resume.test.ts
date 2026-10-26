/**
 * Vendor-activation spec: PAUSED is vendor-resumable (symmetric to
 * disableProduct). resumeProduct() recomputes the correct status from
 * current completeness — never blindly re-publishes an incomplete listing.
 * Policy (19 Oct 2026): verification no longer affects this at all —
 * publishing was never gated on it; only withdrawal is (payouts.service.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  vendorFindUnique: vi.fn(),
  productFindUnique: vi.fn(),
  productUpdate: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: m.vendorFindUnique },
    product: { findUnique: m.productFindUnique, update: m.productUpdate },
    $transaction: vi.fn((fn: (tx: any) => unknown) => fn({ product: { update: m.productUpdate } })),
  },
}));
vi.mock("../modules/products/product-publication-events", () => ({ enqueueProductPublished: vi.fn() }));

import { productsService } from "../modules/products/products.service";

const PAUSED_PRODUCT = {
  id: "p1",
  vendorId: "v1",
  status: "PAUSED",
  images: ["a.jpg"],
  priceInCents: 500,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.vendorFindUnique.mockResolvedValue({ id: "v1", isSuspended: false, verificationStatus: "VERIFIED" });
  m.productFindUnique.mockResolvedValue(PAUSED_PRODUCT);
  m.productUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...PAUSED_PRODUCT, ...data }));
});

describe("productsService.resumeProduct", () => {
  it("resumes a paused, complete listing from a verified vendor to PUBLISHED", async () => {
    const result = await productsService.resumeProduct("user-1", "p1");
    expect(result.status).toBe("PUBLISHED");
    expect(result.isActive).toBe(true);
  });

  it("still resumes to PUBLISHED even when the vendor is unverified — verification never gates publishing", async () => {
    m.vendorFindUnique.mockResolvedValue({ id: "v1", isSuspended: false, verificationStatus: "PENDING" });
    const result = await productsService.resumeProduct("user-1", "p1");
    expect(result.status).toBe("PUBLISHED");
    expect(result.isActive).toBe(true);
  });

  it("refuses to resume a product that isn't PAUSED", async () => {
    m.productFindUnique.mockResolvedValue({ ...PAUSED_PRODUCT, status: "DRAFT" });
    await expect(productsService.resumeProduct("user-1", "p1")).rejects.toMatchObject({ code: "NOT_PAUSED" });
    expect(m.productUpdate).not.toHaveBeenCalled();
  });

  it("refuses a vendor resuming another vendor's product", async () => {
    m.productFindUnique.mockResolvedValue({ ...PAUSED_PRODUCT, vendorId: "someone-else" });
    await expect(productsService.resumeProduct("user-1", "p1")).rejects.toMatchObject({ statusCode: 403 });
  });
});
