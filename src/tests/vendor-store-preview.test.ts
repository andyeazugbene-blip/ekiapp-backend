/**
 * Vendor-activation spec: vendors can preview their complete storefront,
 * including PENDING_ACTIVATION listings not yet visible to buyers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  vendorFindUnique: vi.fn(),
  productFindMany: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: m.vendorFindUnique },
    product: { findMany: m.productFindMany },
  },
}));

import { vendorStorePreviewService } from "../modules/vendors/vendor-store-preview.service";

const VENDOR = {
  id: "vendor-1",
  storeName: "Mama Eki",
  storeSlug: "mama-eki",
  description: "Fresh foodstuff",
  avatar: null,
  coverImage: null,
  city: "London",
  country: "United Kingdom",
  verificationStatus: "PENDING",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.vendorFindUnique.mockResolvedValue(VENDOR);
  m.productFindMany.mockResolvedValue([
    { id: "p1", title: "Jollof Rice", description: null, priceInCents: 1200, currency: "GBP", images: [], category: "Grains", stock: 5, status: "PENDING_ACTIVATION" },
    { id: "p2", title: "Palm Oil", description: null, priceInCents: 800, currency: "GBP", images: [], category: "Oils", stock: 2, status: "PUBLISHED" },
  ]);
});

describe("vendorStorePreviewService.getPreview", () => {
  it("includes PENDING_ACTIVATION listings alongside PUBLISHED ones, each marked whether buyers can see it", async () => {
    const preview = await vendorStorePreviewService.getPreview("user-1");

    expect(preview.storeName).toBe("Mama Eki");
    expect(preview.products).toHaveLength(2);
    expect(preview.products.find((p) => p.id === "p1")).toMatchObject({ status: "PENDING_ACTIVATION", visibleToBuyers: false });
    expect(preview.products.find((p) => p.id === "p2")).toMatchObject({ status: "PUBLISHED", visibleToBuyers: true });

    expect(m.productFindMany.mock.calls[0][0].where).toMatchObject({
      vendorId: "vendor-1",
      status: { in: ["PUBLISHED", "PENDING_ACTIVATION"] },
    });
  });

  it("excludes DRAFT/PAUSED/REJECTED — only PUBLISHED and PENDING_ACTIVATION belong in a storefront preview", async () => {
    await vendorStorePreviewService.getPreview("user-1");
    const statusFilter = m.productFindMany.mock.calls[0][0].where.status.in;
    expect(statusFilter).not.toContain("DRAFT");
    expect(statusFilter).not.toContain("PAUSED");
    expect(statusFilter).not.toContain("REJECTED");
  });

  it("refuses a caller with no vendor profile", async () => {
    m.vendorFindUnique.mockResolvedValue(null);
    await expect(vendorStorePreviewService.getPreview("user-ghost")).rejects.toMatchObject({ statusCode: 403 });
  });
});
