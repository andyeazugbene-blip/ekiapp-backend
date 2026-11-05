/**
 * Admin products screen fixes:
 *  - status/realStatus must never contradict each other (the old 3-state
 *    view re-derived from isActive+adminUnpublishedAt disagreed with the
 *    real 5-state column for PENDING_ACTIVATION rows — a product showed
 *    "Draft" AND "Awaiting activation" badges at once).
 *  - counts now reflect the real 5-state lifecycle, not a collapsed
 *    3-bucket guess.
 *  - admin can now genuinely delete a product with no order/subscription
 *    history; anything with real history is blocked towards Unpublish.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  productGroupBy: vi.fn(),
  productFindUnique: vi.fn(),
  productDelete: vi.fn(),
  cartItemDeleteMany: vi.fn(),
  orderItemCount: vi.fn(),
  subscriptionOfferProductCount: vi.fn(),
  subscriptionItemCount: vi.fn(),
  renewalItemCount: vi.fn(),
  bundleItemCount: vi.fn(),
  flashSaleCount: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    product: {
      findMany: m.productFindMany,
      groupBy: m.productGroupBy,
      findUnique: m.productFindUnique,
      delete: m.productDelete,
      count: vi.fn().mockResolvedValue(0),
    },
    cartItem: { deleteMany: m.cartItemDeleteMany },
    orderItem: { count: m.orderItemCount },
    subscriptionOfferProduct: { count: m.subscriptionOfferProductCount },
    subscriptionItem: { count: m.subscriptionItemCount },
    renewalItem: { count: m.renewalItemCount },
    bundleItem: { count: m.bundleItemCount },
    flashSale: { count: m.flashSaleCount },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { adminProductsService } from "../modules/admin/admin-products.service";

beforeEach(() => {
  vi.clearAllMocks();
  m.productFindMany.mockResolvedValue([]);
  m.productGroupBy.mockResolvedValue([]);
  [m.orderItemCount, m.subscriptionOfferProductCount, m.subscriptionItemCount, m.renewalItemCount, m.bundleItemCount, m.flashSaleCount].forEach((fn) =>
    fn.mockResolvedValue(0),
  );
});

describe("adminProductsService.listProducts — status consistency", () => {
  it("a PENDING_ACTIVATION row's 3-state status is DRAFT, never contradicting realStatus (the double-badge bug)", async () => {
    m.productFindMany.mockResolvedValue([
      {
        id: "p1", productCode: "EKI-1", title: "Palm Oil", images: [], vendorId: "v1", category: "Oils",
        priceInCents: 500, currency: "EUR", stock: 5, isActive: false, status: "PENDING_ACTIVATION",
        createdAt: new Date(), updatedAt: new Date(), subscriptionOfferProducts: [],
        vendor: { storeName: "Shop", userId: "u1", country: "IE", currency: "EUR", verificationStatus: "PENDING", isSuspended: false, closedAt: null, stripeAccountId: null, stripeChargesEnabled: false, bankAccounts: [] },
      },
    ]);

    const result = await adminProductsService.listProducts({});

    expect(result.items[0].status).toBe("DRAFT");
    expect(result.items[0].realStatus).toBe("PENDING_ACTIVATION");
  });

  it("counts reflect the real 5-state lifecycle via groupBy, not a collapsed 3-bucket guess", async () => {
    m.productGroupBy.mockResolvedValue([
      { status: "PUBLISHED", _count: { _all: 3 } },
      { status: "PENDING_ACTIVATION", _count: { _all: 2 } },
      { status: "PAUSED", _count: { _all: 1 } },
      { status: "REJECTED", _count: { _all: 1 } },
      { status: "DRAFT", _count: { _all: 4 } },
    ]);

    const result = await adminProductsService.listProducts({});

    expect(result.counts).toEqual({ published: 3, pendingActivation: 2, paused: 1, rejected: 1, draft: 4, total: 11 });
  });

  it("accepts the real status value directly as a filter", async () => {
    await adminProductsService.listProducts({ status: "PENDING_ACTIVATION" });
    expect(m.productFindMany.mock.calls[0][0].where).toMatchObject({ AND: [{ status: "PENDING_ACTIVATION" }] });
  });

  it("still accepts the legacy ACTIVE/DISABLED filter values, mapped to the real statuses", async () => {
    await adminProductsService.listProducts({ status: "disabled" });
    expect(m.productFindMany.mock.calls[0][0].where).toMatchObject({ AND: [{ status: { in: ["PAUSED", "REJECTED"] } }] });
  });
});
