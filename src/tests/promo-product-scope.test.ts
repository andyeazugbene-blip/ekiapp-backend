/**
 * 20 Oct 2026 fix — a vendor coupon scoped to specific products (the
 * "Foodstuff to apply to" picker on create-discount.tsx) was never actually
 * enforced at redemption: validatePromo computed the discount against the
 * buyer's whole order from that vendor, regardless of PromoCode.productIds.
 * These tests pin the real enforcement in promos.service.ts's validatePromo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  vendorFindUnique: vi.fn(),
  promoCodeFindFirst: vi.fn(),
  promoCodeFindMany: vi.fn(),
  promoCodeCreate: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  productFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
  auditLogFindMany: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: m.vendorFindUnique },
    promoCode: { findFirst: m.promoCodeFindFirst, findMany: m.promoCodeFindMany },
    promoRedemption: { findUnique: m.promoRedemptionFindUnique },
    product: { findMany: m.productFindMany },
    auditLog: { findMany: m.auditLogFindMany },
    $transaction: (fn: any) => fn({ promoCode: { create: m.promoCodeCreate }, auditLog: { create: m.auditLogCreate } }),
  },
}));

vi.mock("../modules/subscriptions/subscriptions.service", () => ({
  subscriptionsService: {
    enforceCouponLimit: vi.fn().mockResolvedValue(undefined),
    enforceBundleLimit: vi.fn().mockResolvedValue(undefined),
  },
}));

import { promosService } from "../modules/promos/promos.service";

const VENDOR = { id: "vendor-1", storeSlug: "queen-african-foods", isSuspended: false };

function promo(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo-1",
    vendorId: "vendor-1",
    code: "SAVE20",
    type: "PERCENTAGE",
    value: 20,
    minOrderAmount: null,
    maxUses: null,
    usedCount: 0,
    isActive: true,
    validFrom: new Date(Date.now() - 1000),
    validUntil: null,
    createdAt: new Date(),
    productIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.vendorFindUnique.mockResolvedValue(VENDOR);
  m.promoRedemptionFindUnique.mockResolvedValue(null);
});

describe("validatePromo — unscoped coupon (productIds empty) keeps existing whole-order behavior", () => {
  it("discounts the full orderAmount", async () => {
    m.promoCodeFindFirst.mockResolvedValue(promo());
    const result = await promosService.validatePromo("buyer-1", { code: "SAVE20", orderAmount: 6000, vendorId: "vendor-1" });
    expect(result.discountAmount).toBe(1200); // 20% of 6000
  });
});

describe("validatePromo — product-scoped coupon only discounts the matching items", () => {
  it("discounts only the scoped product's share, not the full cart", async () => {
    m.promoCodeFindFirst.mockResolvedValue(promo({ productIds: ["prod-A"] }));
    const result = await promosService.validatePromo("buyer-1", {
      code: "SAVE20",
      orderAmount: 6000, // £10 product A + £50 product B
      vendorId: "vendor-1",
      items: [
        { productId: "prod-A", amount: 1000 },
        { productId: "prod-B", amount: 5000 },
      ],
    });
    expect(result.discountAmount).toBe(200); // 20% of 1000, NOT 20% of 6000
  });

  it("refuses when no items are passed for a scoped coupon — can't verify scope", async () => {
    m.promoCodeFindFirst.mockResolvedValue(promo({ productIds: ["prod-A"] }));
    await expect(
      promosService.validatePromo("buyer-1", { code: "SAVE20", orderAmount: 6000, vendorId: "vendor-1" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "PROMO_SCOPE_UNKNOWN" });
  });

  it("refuses when none of the cart items match the scoped product", async () => {
    m.promoCodeFindFirst.mockResolvedValue(promo({ productIds: ["prod-A"] }));
    await expect(
      promosService.validatePromo("buyer-1", {
        code: "SAVE20",
        orderAmount: 5000,
        vendorId: "vendor-1",
        items: [{ productId: "prod-B", amount: 5000 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "PROMO_NOT_APPLICABLE" });
  });

  it("a FIXED_AMOUNT coupon is still capped by the scoped subtotal, not the whole order", async () => {
    m.promoCodeFindFirst.mockResolvedValue(promo({ type: "FIXED_AMOUNT", value: 2000, productIds: ["prod-A"] }));
    const result = await promosService.validatePromo("buyer-1", {
      code: "SAVE20",
      orderAmount: 6000,
      vendorId: "vendor-1",
      items: [
        { productId: "prod-A", amount: 1000 },
        { productId: "prod-B", amount: 5000 },
      ],
    });
    expect(result.discountAmount).toBe(1000); // capped at prod-A's own £10, not the £20 face value
  });
});

describe("createVendorPromoCode — productIds is written to the real, enforced column", () => {
  it("writes productIds onto PromoCode itself, not just the audit log", async () => {
    m.vendorFindUnique.mockResolvedValue(VENDOR);
    m.productFindMany.mockResolvedValue([{ id: "prod-A" }]);
    m.promoCodeFindFirst.mockResolvedValue(null); // no existing code with this name
    m.promoCodeCreate.mockResolvedValue(promo({ productIds: ["prod-A"] }));
    m.auditLogCreate.mockResolvedValue({});

    await promosService.createVendorPromoCode("user-1", {
      code: "SAVE20", type: "PERCENTAGE" as any, value: 20,
      productIds: ["prod-A"], audience: "all",
    });

    expect(m.promoCodeCreate.mock.calls[0][0].data).toMatchObject({ productIds: ["prod-A"] });
  });

  it("refuses a product the vendor doesn't own", async () => {
    m.vendorFindUnique.mockResolvedValue(VENDOR);
    m.productFindMany.mockResolvedValue([]); // none of the requested ids belong to this vendor
    m.promoCodeFindFirst.mockResolvedValue(null);

    await expect(
      promosService.createVendorPromoCode("user-1", {
        code: "SAVE20", type: "PERCENTAGE" as any, value: 20,
        productIds: ["not-mine"], audience: "all",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("listVendorPromoCodes — the real column is authoritative over the audit-log snapshot", () => {
  it("uses PromoCode.productIds even when the audit log says something stale", async () => {
    m.vendorFindUnique.mockResolvedValue(VENDOR);
    m.promoCodeFindMany.mockResolvedValue([promo({ productIds: ["prod-A", "prod-C"] })]);
    m.auditLogFindMany.mockResolvedValue([
      { entityId: "promo-1", metadata: { productIds: ["prod-A"], audience: "all" } }, // stale copy
    ]);

    const [view] = await promosService.listVendorPromoCodes("user-1");
    expect(view.productIds).toEqual(["prod-A", "prod-C"]);
  });
});
