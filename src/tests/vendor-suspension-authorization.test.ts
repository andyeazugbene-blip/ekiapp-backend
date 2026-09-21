/**
 * Acceptance audit fix — a suspended vendor was able to publish new
 * products, advance order status, and request payouts, because none of
 * those write paths checked Vendor.isSuspended (only account existence).
 * This suite proves the fix at the service layer for all three paths, and
 * proves the corresponding read paths (list own products/payouts) stay
 * permissive — a suspended vendor must still be able to see their own
 * dashboard, just not write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    vendorSubscription: { findUnique: vi.fn() },
    product: { count: vi.fn(), create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    order: { findUnique: vi.fn(), update: vi.fn() },
    payoutMethod: { findUnique: vi.fn() },
    payoutRequest: { create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    wallet: { findUnique: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/communications/communication.service", () => ({ communicationService: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../shared/utils/wallet-release", () => ({ releaseVendorEarnings: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/stripe", () => ({ stripe: { transfers: { create: vi.fn() }, payouts: { create: vi.fn() } } }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../modules/subscriptions/subscription-plan-utils", () => ({ resolveVendorWithdrawalFeeBps: vi.fn().mockResolvedValue(0) }));

import { prisma } from "../lib/prisma";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("products.service.ts — suspended vendor cannot write", () => {
  it("createProduct: 404s for a suspended vendor, never reaches product.create", async () => {
    const { productsService } = await import("../modules/products/products.service");
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "VERIFIED", currency: "GBP", country: "United Kingdom", isSuspended: true });

    await expect(
      productsService.createProduct("user-1", { title: "Rice", priceAmount: 1000 } as any),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(m.product.create).not.toHaveBeenCalled();
  });

  it("createProduct: succeeds for a non-suspended vendor (fix doesn't over-block)", async () => {
    const { productsService } = await import("../modules/products/products.service");
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "VERIFIED", currency: "GBP", country: "United Kingdom", isSuspended: false });
    m.product.findFirst.mockResolvedValue(null);
    m.vendorSubscription.findUnique.mockResolvedValue({ plan: "PRO" });
    m.product.count.mockResolvedValue(0);
    m.product.create.mockImplementation(({ data }: any) => Promise.resolve({ id: "p1", ...data }));

    const result = await productsService.createProduct("user-1", { title: "Rice", priceAmount: 1000 } as any);
    expect(result.id).toBe("p1");
  });

  it("updateProduct: 404s for a suspended vendor, never reaches product.update", async () => {
    const { productsService } = await import("../modules/products/products.service");
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", isSuspended: true });

    await expect(
      productsService.updateProduct("user-1", "product-1", { title: "New title" } as any),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(m.product.update).not.toHaveBeenCalled();
  });

  it("listMyProducts: a suspended vendor can still SEE their own products — read paths are not blocked", async () => {
    const { productsService } = await import("../modules/products/products.service");
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", isSuspended: true });
    m.product.findMany.mockResolvedValue([{ id: "p1" }]);

    const result = await productsService.listMyProducts("user-1");
    expect(result).toEqual([{ id: "p1" }]);
  });
});

describe("orders.service.ts — suspended vendor cannot advance order status", () => {
  it("updateVendorOrderStatus: 404s for a suspended vendor, never reaches order lookup or update", async () => {
    const { ordersService } = await import("../modules/orders/orders.service");
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", isSuspended: true });

    await expect(
      ordersService.updateVendorOrderStatus("user-1", "order-1", "SHIPPED" as any),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(m.order.findUnique).not.toHaveBeenCalled();
    expect(m.order.update).not.toHaveBeenCalled();
  });
});

describe("payouts.service.ts — suspended vendor cannot request a payout", () => {
  it("createRequest: 404s for a suspended vendor, never reaches payoutRequest.create", async () => {
    const { payoutsService } = await import("../modules/payouts/payouts.service");
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", isSuspended: true });

    await expect(
      payoutsService.createRequest("user-1", { payoutMethodId: "pm-1", amount: 1000 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(m.payoutMethod.findUnique).not.toHaveBeenCalled();
    expect(m.payoutRequest.create).not.toHaveBeenCalled();
  });

  it("listOwn: a suspended vendor can still SEE their own payout history — read paths are not blocked", async () => {
    const { payoutsService } = await import("../modules/payouts/payouts.service");
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", isSuspended: true });
    m.payoutRequest.findMany.mockResolvedValue([{ id: "pr1" }]);

    const result = await payoutsService.listOwn("user-1");
    expect(result).toEqual([{ id: "pr1" }]);
  });
});
