import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the prisma client BEFORE importing the service.
vi.mock("../lib/prisma", () => {
  return {
    prisma: {
      vendor: {
        findUnique: vi.fn(),
      },
      product: {
        count: vi.fn(),
        findMany: vi.fn(),
      },
      deliveryZone: {
        findMany: vi.fn(),
      },
    },
  };
});

import { prisma } from "../lib/prisma";
import { publicStoresService } from "../modules/public-stores/public-stores.service";
import { AppError } from "../shared/errors/app-error";

const vendorFindUnique = prisma.vendor.findUnique as unknown as ReturnType<typeof vi.fn>;
const productCount = prisma.product.count as unknown as ReturnType<typeof vi.fn>;
const productFindMany = prisma.product.findMany as unknown as ReturnType<typeof vi.fn>;
const deliveryZoneFindMany = prisma.deliveryZone.findMany as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vendorFindUnique.mockReset();
  productCount.mockReset();
  productFindMany.mockReset();
  deliveryZoneFindMany.mockReset();
});

describe("publicStoresService.getStoreBySlug", () => {
  it("returns public profile with shareUrl for an active vendor", async () => {
    vendorFindUnique.mockResolvedValue({
      id: "vendor-1",
      storeName: "Mama Chi Foodstuff",
      storeSlug: "mama-chi-foodstuff",
      description: "Great food",
      avatar: "https://cdn/avatar.png",
      coverImage: null,
      city: "Rome",
      country: "IT",
      verificationStatus: "VERIFIED",
      isSuspended: false,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    productCount.mockResolvedValue(7);
    deliveryZoneFindMany.mockResolvedValue([{ country: "IT" }, { country: "FR" }]);

    const store = await publicStoresService.getStoreBySlug("mama-chi-foodstuff");

    expect(store).toEqual({
      vendorId: "vendor-1",
      storeName: "Mama Chi Foodstuff",
      storeSlug: "mama-chi-foodstuff",
      shareUrl: "https://culinarytales.app/store/mama-chi-foodstuff",
      description: "Great food",
      avatar: "https://cdn/avatar.png",
      coverImage: null,
      city: "Rome",
      country: "IT",
      verificationStatus: "VERIFIED",
      rating: null,
      totalProducts: 7,
      deliveryCountries: ["IT", "FR"],
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
  });

  it("does NOT expose private vendor fields (email, phone, stripe, wallet)", async () => {
    vendorFindUnique.mockResolvedValue({
      id: "vendor-1",
      storeName: "Test",
      storeSlug: "test",
      description: null,
      avatar: null,
      coverImage: null,
      city: null,
      country: null,
      verificationStatus: "PENDING",
      isSuspended: false,
      createdAt: new Date(),
    });
    productCount.mockResolvedValue(0);
    deliveryZoneFindMany.mockResolvedValue([]);

    const store = (await publicStoresService.getStoreBySlug("test")) as unknown as Record<
      string,
      unknown
    >;

    expect(store.contactEmail).toBeUndefined();
    expect(store.contactPhone).toBeUndefined();
    expect(store.stripeAccountId).toBeUndefined();
    expect(store.stripePayoutsEnabled).toBeUndefined();
    expect(store.userId).toBeUndefined();
    expect(store.wallet).toBeUndefined();
    expect(store.suspendedReason).toBeUndefined();
  });

  it("returns 404 when vendor does not exist", async () => {
    vendorFindUnique.mockResolvedValue(null);

    await expect(publicStoresService.getStoreBySlug("nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns 404 when vendor is suspended", async () => {
    vendorFindUnique.mockResolvedValue({
      id: "vendor-1",
      storeName: "Suspended",
      storeSlug: "suspended",
      description: null,
      avatar: null,
      coverImage: null,
      city: null,
      country: null,
      verificationStatus: "VERIFIED",
      isSuspended: true,
      createdAt: new Date(),
    });

    await expect(publicStoresService.getStoreBySlug("suspended")).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe("publicStoresService.listStoreProducts", () => {
  it("returns only active products for the vendor", async () => {
    vendorFindUnique.mockResolvedValue({ id: "vendor-1", isSuspended: false });
    productFindMany.mockResolvedValue([
      {
        id: "p1",
        vendorId: "vendor-1",
        title: "Product 1",
        description: null,
        priceInCents: 1000,
        currency: "usd",
        images: [],
        category: null,
        stock: 5,
        weightGrams: null,
        createdAt: new Date(),
      },
    ]);

    const result = await publicStoresService.listStoreProducts("test", { limit: 20 });

    expect(productFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ vendorId: "vendor-1", isActive: true }),
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("returns 404 when vendor is suspended", async () => {
    vendorFindUnique.mockResolvedValue({ id: "vendor-1", isSuspended: true });

    await expect(
      publicStoresService.listStoreProducts("test", { limit: 20 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 404 when vendor not found", async () => {
    vendorFindUnique.mockResolvedValue(null);

    await expect(
      publicStoresService.listStoreProducts("nope", { limit: 20 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("handles cursor pagination with nextCursor", async () => {
    vendorFindUnique.mockResolvedValue({ id: "vendor-1", isSuspended: false });
    // Return limit+1 items so the service computes nextCursor
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`,
      vendorId: "vendor-1",
      title: `Product ${i}`,
      description: null,
      priceInCents: 1000,
      currency: "usd",
      images: [],
      category: null,
      stock: 5,
      weightGrams: null,
      createdAt: new Date(),
    }));
    productFindMany.mockResolvedValue(items);

    const result = await publicStoresService.listStoreProducts("test", { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe("p2");
  });
});
