/**
 * Real public discovery for Regular Delivery offers — architecture gap
 * closure. A buyer must be able to find a vendor's offer without a
 * previous purchase, a deep link, or an existing subscription; the only
 * path in before this was a reorder suggestion or a direct link to a
 * known offer id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    subscriptionOffer: { findMany: vi.fn() },
  },
}));

vi.mock("../modules/community-buy/market-configuration.service", () => ({
  marketConfigurationService: { get: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { subscriptionOffersService } from "../modules/regular-deliveries/subscription-offers.service";

const m = vi.mocked(prisma, true);
const getMarketConfig = vi.mocked(marketConfigurationService.get);

beforeEach(() => vi.clearAllMocks());

describe("subscriptionOffersService.listPublic — market-aware, no private vendor data", () => {
  it("returns an empty list, not an error, when the buyer's market has Regular Deliveries disabled", async () => {
    getMarketConfig.mockResolvedValue({ regularDeliveriesEnabled: false } as never);

    const result = await subscriptionOffersService.listPublic({ country: "GB" });

    expect(result).toEqual([]);
    expect(m.subscriptionOffer.findMany).not.toHaveBeenCalled();
  });

  it("queries real offers when the market has Regular Deliveries enabled", async () => {
    getMarketConfig.mockResolvedValue({ regularDeliveriesEnabled: true } as never);
    m.subscriptionOffer.findMany.mockResolvedValue([{ id: "offer-1" }] as never);

    const result = await subscriptionOffersService.listPublic({ country: "GB" });

    expect(result).toEqual([{ id: "offer-1" }]);
    expect(m.subscriptionOffer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          vendor: { isSuspended: false, country: { equals: "GB", mode: "insensitive" } },
        }),
      }),
    );
  });

  it("never checks market config (and never blocks) when browsing without a country — a specific vendor lookup can still work", async () => {
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({ vendorId: "vendor-1" });

    expect(getMarketConfig).not.toHaveBeenCalled();
    expect(m.subscriptionOffer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ vendorId: "vendor-1" }) }),
    );
  });

  it("only ever selects public-safe vendor fields — no contact, payout, or verification data", async () => {
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({});

    const call = m.subscriptionOffer.findMany.mock.calls[0][0] as { include: { vendor: { select: Record<string, unknown> } } };
    const vendorSelect = call.include.vendor.select;
    expect(Object.keys(vendorSelect).sort()).toEqual(["avatar", "city", "country", "id", "storeName"]);
    expect(vendorSelect).not.toHaveProperty("stripeAccountId");
    expect(vendorSelect).not.toHaveProperty("contactEmail");
  });

  it("only includes real, orderable, non-paused products", async () => {
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({});

    const call = m.subscriptionOffer.findMany.mock.calls[0][0] as { where: { products: { some: Record<string, unknown> } } };
    expect(call.where.products.some).toEqual(
      expect.objectContaining({ pausedAt: null, product: { isActive: true, stock: { gt: 0 } } }),
    );
  });
});
