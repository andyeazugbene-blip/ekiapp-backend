import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    orderItem: { findMany: vi.fn() },
    buyerSubscription: { findMany: vi.fn() },
    subscriptionOfferProduct: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { buyerSubscriptionsService } from "../modules/regular-deliveries/buyer-subscriptions.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buyerSubscriptionsService.getReorderSuggestions — real purchase-history-driven, no invented logic", () => {
  it("returns nothing when the buyer has no completed purchases in the window", async () => {
    m.orderItem.findMany.mockResolvedValue([] as never);
    const result = await buyerSubscriptionsService.getReorderSuggestions("buyer-1");
    expect(result).toEqual([]);
    expect(m.buyerSubscription.findMany).not.toHaveBeenCalled();
  });

  it("excludes a product bought only once — repeat purchase requires at least 2", async () => {
    m.orderItem.findMany.mockResolvedValue([{ productId: "p1" }] as never);
    const result = await buyerSubscriptionsService.getReorderSuggestions("buyer-1");
    expect(result).toEqual([]);
    expect(m.buyerSubscription.findMany).not.toHaveBeenCalled();
  });

  it("excludes a repeatedly-bought product the buyer is already actively subscribed to", async () => {
    m.orderItem.findMany.mockResolvedValue([{ productId: "p1" }, { productId: "p1" }] as never);
    m.buyerSubscription.findMany.mockResolvedValue([{ items: [{ productId: "p1" }] }] as never);

    const result = await buyerSubscriptionsService.getReorderSuggestions("buyer-1");

    expect(result).toEqual([]);
    expect(m.subscriptionOfferProduct.findMany).not.toHaveBeenCalled();
  });

  it("excludes a repeatedly-bought product with no active Regular Delivery offer available", async () => {
    m.orderItem.findMany.mockResolvedValue([{ productId: "p1" }, { productId: "p1" }] as never);
    m.buyerSubscription.findMany.mockResolvedValue([] as never);
    m.subscriptionOfferProduct.findMany.mockResolvedValue([] as never);

    const result = await buyerSubscriptionsService.getReorderSuggestions("buyer-1");

    expect(result).toEqual([]);
    expect(m.subscriptionOfferProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ productId: { in: ["p1"] } }) }),
    );
  });

  it("suggests a repeatedly-bought, not-yet-subscribed product that has a real offer, with the real order count", async () => {
    m.orderItem.findMany.mockResolvedValue([{ productId: "p1" }, { productId: "p1" }, { productId: "p1" }] as never);
    m.buyerSubscription.findMany.mockResolvedValue([] as never);
    m.subscriptionOfferProduct.findMany.mockResolvedValue([
      {
        productId: "p1",
        product: { id: "p1", title: "Basmati Rice 5kg", priceInCents: 1200, currency: "GBP", images: [] },
        offer: { id: "offer-1", title: "Weekly Grocery Box", frequencies: ["WEEKLY"], vendor: { storeName: "Green Grocer" } },
      },
    ] as never);

    const result = await buyerSubscriptionsService.getReorderSuggestions("buyer-1");

    expect(result).toEqual([
      {
        product: { id: "p1", title: "Basmati Rice 5kg", priceInCents: 1200, currency: "GBP", images: [] },
        offer: { id: "offer-1", title: "Weekly Grocery Box", frequencies: ["WEEKLY"], vendorStoreName: "Green Grocer" },
        orderCount: 3,
      },
    ]);
  });
});
