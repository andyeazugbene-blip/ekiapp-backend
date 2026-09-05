import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    orderItem: { findMany: vi.fn() },
    buyerSubscription: { findMany: vi.fn(), create: vi.fn() },
    subscriptionOfferProduct: { findMany: vi.fn() },
    subscriptionOffer: { findUnique: vi.fn() },
    buyerAddress: { findUnique: vi.fn() },
    buyerPaymentMethod: { findUnique: vi.fn() },
    subscriptionActionHistory: { create: vi.fn() },
  },
}));

vi.mock("../modules/community-buy/market-configuration.service", () => ({
  marketConfigurationService: { list: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { buyerSubscriptionsService } from "../modules/regular-deliveries/buyer-subscriptions.service";

const m = vi.mocked(prisma, true);
const listMarketConfigs = vi.mocked(marketConfigurationService.list);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: Regular Deliveries enabled in the UK — matches baseOffer's vendor.
  listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: true }] as never);
});

describe("buyerSubscriptionsService.create — offer approval threshold copy-through (spec §22)", () => {
  const baseOffer = {
    id: "offer-1",
    isActive: true,
    frequencies: ["WEEKLY"],
    vendor: { isSuspended: false, country: "United Kingdom" },
    products: [{ productId: "p1", pausedAt: null, product: { isActive: true, stock: 5 } }],
  };
  const baseAddress = { id: "addr-1", buyerId: "buyer-1" };
  const basePaymentMethod = { id: "pm-1", buyerId: "buyer-1" };
  const baseInput = {
    offerId: "offer-1",
    frequency: "WEEKLY" as const,
    deliveryAddressId: "addr-1",
    paymentMethodId: "pm-1",
    items: [{ productId: "p1", quantity: 1 }],
  };

  it("copies the offer's configured maxPriceIncreaseApprovalBps onto the new subscription", async () => {
    m.subscriptionOffer.findUnique.mockResolvedValue({ ...baseOffer, maxPriceIncreaseApprovalBps: 1000 } as never);
    m.buyerAddress.findUnique.mockResolvedValue(baseAddress as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue(basePaymentMethod as never);
    m.buyerSubscription.create.mockResolvedValue({ id: "sub-new" } as never);

    await buyerSubscriptionsService.create("buyer-1", baseInput);

    expect(m.buyerSubscription.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priceChangeApprovalLimitBps: 1000 }) }),
    );
  });

  it("leaves the subscription on the system default when the offer has no configured threshold", async () => {
    m.subscriptionOffer.findUnique.mockResolvedValue({ ...baseOffer, maxPriceIncreaseApprovalBps: null } as never);
    m.buyerAddress.findUnique.mockResolvedValue(baseAddress as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue(basePaymentMethod as never);
    m.buyerSubscription.create.mockResolvedValue({ id: "sub-new" } as never);

    await buyerSubscriptionsService.create("buyer-1", baseInput);

    const call = m.buyerSubscription.create.mock.calls[0]![0] as any;
    expect(call.data.priceChangeApprovalLimitBps).toBeUndefined();
  });
});

describe("buyerSubscriptionsService.create — re-enforces listPublic's own eligibility rules (closes the direct-offer-id bypass)", () => {
  const baseOffer = {
    id: "offer-1",
    isActive: true,
    frequencies: ["WEEKLY"],
    vendor: { isSuspended: false, country: "United Kingdom" },
    products: [{ productId: "p1", pausedAt: null, product: { isActive: true, stock: 5 } }],
  };
  const baseAddress = { id: "addr-1", buyerId: "buyer-1" };
  const basePaymentMethod = { id: "pm-1", buyerId: "buyer-1" };
  const baseInput = {
    offerId: "offer-1",
    frequency: "WEEKLY" as const,
    deliveryAddressId: "addr-1",
    paymentMethodId: "pm-1",
    items: [{ productId: "p1", quantity: 1 }],
  };

  beforeEach(() => {
    m.buyerAddress.findUnique.mockResolvedValue(baseAddress as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue(basePaymentMethod as never);
    m.buyerSubscription.create.mockResolvedValue({ id: "sub-new" } as never);
  });

  it("rejects a subscribe attempt against a suspended vendor — a buyer with just the offer id must not bypass the browse-list filter", async () => {
    m.subscriptionOffer.findUnique.mockResolvedValue({
      ...baseOffer,
      vendor: { isSuspended: true, country: "United Kingdom" },
    } as never);

    await expect(buyerSubscriptionsService.create("buyer-1", baseInput)).rejects.toThrow(
      "This vendor is not currently accepting orders",
    );
    expect(m.buyerSubscription.create).not.toHaveBeenCalled();
  });

  it("rejects a subscribe attempt when the vendor's market has Regular Deliveries disabled", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: false }] as never);
    m.subscriptionOffer.findUnique.mockResolvedValue(baseOffer as never);

    await expect(buyerSubscriptionsService.create("buyer-1", baseInput)).rejects.toThrow(
      "Regular Deliveries are not available in this vendor's market",
    );
    expect(m.buyerSubscription.create).not.toHaveBeenCalled();
  });

  it("rejects a subscribe attempt for a product that's been paused since the offer was last browsed", async () => {
    m.subscriptionOffer.findUnique.mockResolvedValue({
      ...baseOffer,
      products: [{ productId: "p1", pausedAt: new Date(), product: { isActive: true, stock: 5 } }],
    } as never);

    await expect(buyerSubscriptionsService.create("buyer-1", baseInput)).rejects.toThrow(
      "Product not eligible for this offer",
    );
    expect(m.buyerSubscription.create).not.toHaveBeenCalled();
  });

  it("rejects a subscribe attempt for a product that's gone out of stock since the offer was last browsed", async () => {
    m.subscriptionOffer.findUnique.mockResolvedValue({
      ...baseOffer,
      products: [{ productId: "p1", pausedAt: null, product: { isActive: true, stock: 0 } }],
    } as never);

    await expect(buyerSubscriptionsService.create("buyer-1", baseInput)).rejects.toThrow(
      "Product not eligible for this offer",
    );
    expect(m.buyerSubscription.create).not.toHaveBeenCalled();
  });

  it("allows a legitimate subscribe when the vendor is active, the market is enabled, and the product is orderable", async () => {
    m.subscriptionOffer.findUnique.mockResolvedValue(baseOffer as never);

    await buyerSubscriptionsService.create("buyer-1", baseInput);

    expect(m.buyerSubscription.create).toHaveBeenCalled();
  });
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
