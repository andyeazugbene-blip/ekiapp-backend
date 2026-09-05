/**
 * Real public discovery for Regular Delivery offers — architecture gap
 * closure. A buyer must be able to find a vendor's offer without a
 * previous purchase, a deep link, or an existing subscription; the only
 * path in before this was a reorder suggestion or a direct link to a
 * known offer id.
 *
 * MarketConfiguration is keyed by ISO country code ("GB") while
 * Vendor.country stores full names ("United Kingdom") — listPublic must
 * translate between the two, and must apply the enabled-market gate by
 * each offer's own vendor country ALWAYS, not only when the caller
 * happens to pass a `country` filter (that was the real production bug:
 * the default "browse all markets" request skipped the gate entirely).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    subscriptionOffer: { findMany: vi.fn() },
  },
}));

vi.mock("../modules/community-buy/market-configuration.service", () => ({
  marketConfigurationService: { list: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { subscriptionOffersService } from "../modules/regular-deliveries/subscription-offers.service";

const m = vi.mocked(prisma, true);
const listMarketConfigs = vi.mocked(marketConfigurationService.list);

const GB_NAMES = ["United Kingdom", "UK", "England", "Scotland", "Wales"];

beforeEach(() => vi.clearAllMocks());

describe("subscriptionOffersService.listPublic — market-aware, no private vendor data", () => {
  it("returns an empty list, not an error, when the requested market has Regular Deliveries disabled", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: false }] as never);

    const result = await subscriptionOffersService.listPublic({ country: "GB" });

    expect(result).toEqual([]);
    expect(m.subscriptionOffer.findMany).not.toHaveBeenCalled();
  });

  it("queries real offers, scoped to every name variant of the enabled market, when Regular Deliveries is enabled", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: true }] as never);
    m.subscriptionOffer.findMany.mockResolvedValue([{ id: "offer-1" }] as never);

    const result = await subscriptionOffersService.listPublic({ country: "GB" });

    expect(result).toEqual([{ id: "offer-1" }]);
    expect(m.subscriptionOffer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          vendor: { isSuspended: false, country: { in: expect.arrayContaining(GB_NAMES), mode: "insensitive" } },
        }),
      }),
    );
  });

  it("still enforces the enabled-market gate when browsing without a country filter — a vendor in a disabled market must not appear via a direct vendorId lookup either", async () => {
    listMarketConfigs.mockResolvedValue([
      { countryCode: "GB", regularDeliveriesEnabled: true },
      { countryCode: "US", regularDeliveriesEnabled: false },
    ] as never);
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({ vendorId: "vendor-1" });

    expect(listMarketConfigs).toHaveBeenCalled();
    const call = m.subscriptionOffer.findMany.mock.calls[0][0] as {
      where: { vendorId: string; vendor: { country: { in: string[] } } };
    };
    expect(call.where.vendorId).toBe("vendor-1");
    // Only GB's name variants are in the whitelist — US is disabled and must
    // not be able to leak through just because no explicit country was asked for.
    expect(call.where.vendor.country.in).toEqual(expect.arrayContaining(GB_NAMES));
    expect(call.where.vendor.country.in).not.toEqual(expect.arrayContaining(["United States"]));
  });

  it("returns an empty list when no market has Regular Deliveries enabled at all", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: false }] as never);

    const result = await subscriptionOffersService.listPublic({});

    expect(result).toEqual([]);
    expect(m.subscriptionOffer.findMany).not.toHaveBeenCalled();
  });

  it("only ever selects public-safe vendor fields — no contact, payout, or verification data", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: true }] as never);
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({});

    const call = m.subscriptionOffer.findMany.mock.calls[0][0] as { include: { vendor: { select: Record<string, unknown> } } };
    const vendorSelect = call.include.vendor.select;
    expect(Object.keys(vendorSelect).sort()).toEqual(["avatar", "city", "country", "id", "storeName"]);
    expect(vendorSelect).not.toHaveProperty("stripeAccountId");
    expect(vendorSelect).not.toHaveProperty("contactEmail");
  });

  it("only includes real, orderable, non-paused products", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: true }] as never);
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({});

    const call = m.subscriptionOffer.findMany.mock.calls[0][0] as { where: { products: { some: Record<string, unknown> } } };
    expect(call.where.products.some).toEqual(
      expect.objectContaining({ pausedAt: null, product: { isActive: true, stock: { gt: 0 } } }),
    );
  });
});
