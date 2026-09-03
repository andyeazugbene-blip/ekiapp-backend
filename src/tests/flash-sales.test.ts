import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    product: { findFirst: vi.fn() },
    flashSale: { findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../modules/vendors/vendors.service", () => ({
  buildVendorShareUrl: (slug: string) => `https://culinarytales.app/store/${slug}`,
}));

import { prisma } from "../lib/prisma";
import { flashSalesService } from "../modules/promos/flash-sales.service";

const m = vi.mocked(prisma, true);
const vendor = { id: "vendor-1", storeSlug: "queen-foods", isSuspended: false };

beforeEach(() => vi.clearAllMocks());

describe("flashSalesService.create — real start/end validation (client mandate 2026-09), never existed before", () => {
  it("rejects endsAt equal to startsAt", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    await expect(
      flashSalesService.create("user-1", { productId: "p1", salePriceMinor: 500, currency: "GBP", startsAt: "2026-06-01T10:00:00Z", endsAt: "2026-06-01T10:00:00Z" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects endsAt before startsAt", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    await expect(
      flashSalesService.create("user-1", { productId: "p1", salePriceMinor: 500, currency: "GBP", startsAt: "2026-06-02T00:00:00Z", endsAt: "2026-06-01T00:00:00Z" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an invalid date string instead of silently coercing it", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    await expect(
      flashSalesService.create("user-1", { productId: "p1", salePriceMinor: 500, currency: "GBP", startsAt: "not-a-date", endsAt: "2026-06-01T00:00:00Z" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a sale price that isn't actually below the product's real price", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.product.findFirst.mockResolvedValue({ id: "p1", priceInCents: 1000, currency: "GBP" } as never);
    await expect(
      flashSalesService.create("user-1", { productId: "p1", salePriceMinor: 1200, currency: "GBP", startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-02T00:00:00Z" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates a real FlashSale row with the actual salePriceMinor and dates persisted — never lost, never zeroed", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.product.findFirst.mockResolvedValue({ id: "p1", priceInCents: 1000, currency: "GBP" } as never);
    const promoCreate = vi.fn().mockResolvedValue({ id: "promo-1", code: "FLASH202609ABCD" });
    const flashCreate = vi.fn().mockResolvedValue({
      id: "flash-1", productId: "p1", salePriceMinor: 700, currency: "GBP",
      startsAt: new Date("2026-06-01T00:00:00Z"), endsAt: new Date("2026-06-02T00:00:00Z"), isActive: true,
      product: { priceInCents: 1000 }, promoCode: { code: "FLASH202609ABCD" },
    });
    m.$transaction.mockImplementationOnce(async (cb: any) => cb({ promoCode: { create: promoCreate }, flashSale: { create: flashCreate } }));

    const result = await flashSalesService.create("user-1", { productId: "p1", salePriceMinor: 700, currency: "GBP", startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-02T00:00:00Z" });

    expect(promoCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "FIXED_AMOUNT", value: 300 }) }));
    expect(result.salePriceMinor).toBe(700); // the real price, not 0
    expect(result.currency).toBe("GBP");
  });
});

describe("flashSalesService.listMine — status computed live from real dates, never invented", () => {
  const baseRow = { id: "f1", productId: "p1", salePriceMinor: 700, currency: "GBP", isActive: true, product: { priceInCents: 1000 }, promoCode: { code: "FLASH1", usedCount: 0 } };

  it("reports UPCOMING when now is before startsAt", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.flashSale.findMany.mockResolvedValue([{ ...baseRow, startsAt: new Date(Date.now() + 100000), endsAt: new Date(Date.now() + 200000) }] as never);
    const rows = await flashSalesService.listMine("user-1");
    expect(rows[0].status).toBe("UPCOMING");
  });

  it("reports ACTIVE when now is between startsAt and endsAt", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.flashSale.findMany.mockResolvedValue([{ ...baseRow, startsAt: new Date(Date.now() - 100000), endsAt: new Date(Date.now() + 100000) }] as never);
    const rows = await flashSalesService.listMine("user-1");
    expect(rows[0].status).toBe("ACTIVE");
  });

  it("reports EXPIRED when now is after endsAt", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.flashSale.findMany.mockResolvedValue([{ ...baseRow, startsAt: new Date(Date.now() - 200000), endsAt: new Date(Date.now() - 100000) }] as never);
    const rows = await flashSalesService.listMine("user-1");
    expect(rows[0].status).toBe("EXPIRED");
  });

  it("reports INACTIVE when isActive is false, regardless of dates", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.flashSale.findMany.mockResolvedValue([{ ...baseRow, isActive: false, startsAt: new Date(Date.now() - 100000), endsAt: new Date(Date.now() + 100000) }] as never);
    const rows = await flashSalesService.listMine("user-1");
    expect(rows[0].status).toBe("INACTIVE");
  });
});

describe("flashSalesService.listPublic — only real, currently-active-by-date sales", () => {
  it("queries with isActive + startsAt/endsAt window, not a prefix scan", async () => {
    m.flashSale.findMany.mockResolvedValue([]);
    await flashSalesService.listPublic();
    expect(m.flashSale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          startsAt: expect.objectContaining({ lte: expect.any(Date) }),
          endsAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
  });
});

describe("flashSalesService.remove", () => {
  it("refuses to delete a flash sale that has already been purchased", async () => {
    m.vendor.findUnique.mockResolvedValue(vendor as never);
    m.flashSale.findFirst.mockResolvedValue({ id: "f1", promoCode: { usedCount: 2 } } as never);
    await expect(flashSalesService.remove("user-1", "f1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.flashSale.delete).not.toHaveBeenCalled();
  });
});
