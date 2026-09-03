import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    product: { findMany: vi.fn() },
    bundle: { findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../modules/vendors/vendors.service", () => ({
  buildVendorShareUrl: (slug: string) => `https://culinarytales.app/store/${slug}`,
}));

vi.mock("../modules/subscriptions/subscriptions.service", () => ({
  subscriptionsService: { enforceBundleLimit: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { bundlesService } from "../modules/promos/bundles.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("bundlesService.create — real structured data, no upfront money captured by this action", () => {
  const vendor = { id: "vendor-1", storeSlug: "queen-foods", isSuspended: false };

  it("rejects fewer than 2 products", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    await expect(
      bundlesService.create("user-1", { name: "Duo pack", productIds: ["p1"], bundlePriceMinor: 500, currency: "GBP" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a product that doesn't belong to this vendor", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.product.findMany.mockResolvedValue([{ id: "p1", priceInCents: 1000, currency: "GBP" }] as never); // only 1 of 2 found
    await expect(
      bundlesService.create("user-1", { name: "Duo pack", productIds: ["p1", "p2"], bundlePriceMinor: 500, currency: "GBP" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a bundle price that isn't actually a discount off the real regular total", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.product.findMany.mockResolvedValue([
      { id: "p1", priceInCents: 1000, currency: "GBP" },
      { id: "p2", priceInCents: 1000, currency: "GBP" },
    ] as never);
    await expect(
      bundlesService.create("user-1", { name: "Duo pack", productIds: ["p1", "p2"], bundlePriceMinor: 2500, currency: "GBP" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates a real Bundle row with the actual bundlePriceMinor persisted — never lost, never zeroed", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.product.findMany.mockResolvedValue([
      { id: "p1", priceInCents: 1000, currency: "GBP" },
      { id: "p2", priceInCents: 1000, currency: "GBP" },
    ] as never);
    const promoCreate = vi.fn().mockResolvedValue({ id: "promo-1", code: "BUNDLE202609ABCD" });
    const bundleCreate = vi.fn().mockResolvedValue({
      id: "bundle-1", name: "Duo pack", bundlePriceMinor: 1500, currency: "GBP",
      items: [{ product: { priceInCents: 1000 } }, { product: { priceInCents: 1000 } }],
      promoCode: { code: "BUNDLE202609ABCD" },
    });
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ promoCode: { create: promoCreate }, bundle: { create: bundleCreate } }));

    const result = await bundlesService.create("user-1", { name: "Duo pack", productIds: ["p1", "p2"], bundlePriceMinor: 1500, currency: "GBP" });

    // Discount value = regularTotal(2000) - bundlePrice(1500) = 500
    expect(promoCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "FIXED_AMOUNT", value: 500 }) }));
    expect(result.bundlePriceMinor).toBe(1500); // the real price, not 0
    expect(result.currency).toBe("GBP");
    expect(result.shareUrl).toContain("queen-foods");
  });
});

describe("bundlesService.listMine — real prices returned, never 0", () => {
  it("computes regularPriceMinor live from the joined products, returns the real stored bundlePriceMinor", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", storeSlug: "queen-foods", isSuspended: false } as never);
    m.bundle.findMany.mockResolvedValue([
      {
        id: "bundle-1", name: "Duo pack", bundlePriceMinor: 1500, currency: "GBP",
        items: [{ product: { priceInCents: 1000 } }, { product: { priceInCents: 1000 } }],
        promoCode: { code: "BUNDLE1", usedCount: 0 },
      },
    ] as never);

    const bundles = await bundlesService.listMine("user-1");

    expect(bundles[0].bundlePriceMinor).toBe(1500);
    expect(bundles[0].regularPriceMinor).toBe(2000);
  });
});

describe("bundlesService.remove", () => {
  it("refuses to delete a bundle that has already been purchased", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", storeSlug: "queen-foods", isSuspended: false } as never);
    m.bundle.findFirst.mockResolvedValue({ id: "bundle-1", promoCode: { usedCount: 3 } } as never);
    await expect(bundlesService.remove("user-1", "bundle-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.bundle.delete).not.toHaveBeenCalled();
  });

  it("deletes a never-purchased bundle", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", storeSlug: "queen-foods", isSuspended: false } as never);
    m.bundle.findFirst.mockResolvedValue({ id: "bundle-1", promoCode: { usedCount: 0 } } as never);
    m.bundle.delete.mockResolvedValue({} as never);
    await bundlesService.remove("user-1", "bundle-1");
    expect(m.bundle.delete).toHaveBeenCalledWith({ where: { id: "bundle-1" } });
  });
});
