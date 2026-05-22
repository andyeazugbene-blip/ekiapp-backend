import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    vendorSubscription: { findUnique: vi.fn() },
    product: { count: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { productsService } from "../modules/products/products.service";

const vendorFindUnique = prisma.vendor.findUnique as unknown as ReturnType<typeof vi.fn>;
const subscriptionFindUnique = prisma.vendorSubscription.findUnique as unknown as ReturnType<typeof vi.fn>;
const productCount = prisma.product.count as unknown as ReturnType<typeof vi.fn>;
const productCreate = prisma.product.create as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("Product currency inherits from vendor", () => {
  it("UK vendor creates product with input.currency=EUR → product.currency must be GBP", async () => {
    vendorFindUnique.mockResolvedValue({
      id: "vendor-uk",
      verificationStatus: "VERIFIED",
      currency: "GBP",
      country: "United Kingdom",
    });
    subscriptionFindUnique.mockResolvedValue({ plan: "PRO" });
    productCount.mockResolvedValue(0);
    productCreate.mockImplementation(({ data }: any) => Promise.resolve({ id: "p1", ...data }));

    const result = await productsService.createProduct("user-uk", {
      title: "Fish and Chips",
      priceAmount: 1500,
      currency: "EUR", // Buyer tries to set EUR — should be ignored
    });

    expect(result.currency).toBe("GBP");
    expect(productCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: "GBP" }),
      }),
    );
  });

  it("Nigeria vendor creates product with input.currency=USD → product.currency must be NGN", async () => {
    vendorFindUnique.mockResolvedValue({
      id: "vendor-ng",
      verificationStatus: "VERIFIED",
      currency: "NGN",
      country: "Nigeria",
    });
    subscriptionFindUnique.mockResolvedValue({ plan: "FREE" });
    productCount.mockResolvedValue(0);
    productCreate.mockImplementation(({ data }: any) => Promise.resolve({ id: "p2", ...data }));

    const result = await productsService.createProduct("user-ng", {
      title: "Jollof Rice",
      priceAmount: 500000,
      currency: "USD", // Ignored
    });

    expect(result.currency).toBe("NGN");
  });

  it("Vendor without currency field falls back to country derivation", async () => {
    vendorFindUnique.mockResolvedValue({
      id: "vendor-gh",
      verificationStatus: "VERIFIED",
      currency: "", // Empty — should derive from country
      country: "Ghana",
    });
    subscriptionFindUnique.mockResolvedValue({ plan: "GROWTH" });
    productCount.mockResolvedValue(0);
    productCreate.mockImplementation(({ data }: any) => Promise.resolve({ id: "p3", ...data }));

    const result = await productsService.createProduct("user-gh", {
      title: "Banku",
      priceAmount: 2000,
    });

    expect(result.currency).toBe("GHS");
  });

  it("Italy vendor gets EUR", async () => {
    vendorFindUnique.mockResolvedValue({
      id: "vendor-it",
      verificationStatus: "VERIFIED",
      currency: "EUR",
      country: "Italy",
    });
    subscriptionFindUnique.mockResolvedValue({ plan: "FREE" });
    productCount.mockResolvedValue(0);
    productCreate.mockImplementation(({ data }: any) => Promise.resolve({ id: "p4", ...data }));

    const result = await productsService.createProduct("user-it", {
      title: "Pasta",
      priceAmount: 1299,
      currency: "GBP", // Ignored
    });

    expect(result.currency).toBe("EUR");
  });
});
