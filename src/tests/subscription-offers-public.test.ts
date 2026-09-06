/**
 * Real public discovery for Regular Delivery offers — architecture gap
 * closure. A buyer must be able to find a vendor's offer without a
 * previous purchase, a deep link, or an existing subscription; the only
 * path in before this was a reorder suggestion or a direct link to a
 * known offer id.
 *
 * Eligibility is resolved via VendorMarketAssignment (a vendor is
 * discoverable through ANY market they hold an active assignment for —
 * see subscription-offers.service.ts's "inherit all active vendor markets"
 * decision), matched against MarketConfiguration.countryCode (an ISO code
 * like "GB") — not Vendor.country's single free-text string. The gate must
 * apply ALWAYS, not only when the caller happens to pass a `country`
 * filter (that was the real production bug: the default "browse all
 * markets" request skipped the gate entirely).
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

beforeEach(() => vi.clearAllMocks());

describe("subscriptionOffersService.listPublic — market-aware, no private vendor data", () => {
  it("returns an empty list, not an error, when the requested market has Regular Deliveries disabled", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: false }] as never);

    const result = await subscriptionOffersService.listPublic({ country: "GB" });

    expect(result).toEqual([]);
    expect(m.subscriptionOffer.findMany).not.toHaveBeenCalled();
  });

  it("queries real offers via an active VendorMarketAssignment relation, scoped to the enabled market's code, when Regular Deliveries is enabled", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: true }] as never);
    m.subscriptionOffer.findMany.mockResolvedValue([{ id: "offer-1" }] as never);

    const result = await subscriptionOffersService.listPublic({ country: "GB" });

    expect(result).toEqual([{ id: "offer-1" }]);
    expect(m.subscriptionOffer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          vendor: {
            isSuspended: false,
            marketAssignments: { some: { enabled: true, marketCode: { in: ["GB"] } } },
          },
        }),
      }),
    );
  });

  it("accepts a full country name filter (not just an ISO code) and resolves it to the same market code", async () => {
    listMarketConfigs.mockResolvedValue([{ countryCode: "GB", regularDeliveriesEnabled: true }] as never);
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({ country: "United Kingdom" });

    const call = m.subscriptionOffer.findMany.mock.calls[0][0] as {
      where: { vendor: { marketAssignments: { some: { marketCode: { in: string[] } } } } };
    };
    expect(call.where.vendor.marketAssignments.some.marketCode.in).toEqual(["GB"]);
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
      where: { vendorId: string; vendor: { marketAssignments: { some: { marketCode: { in: string[] } } } } };
    };
    expect(call.where.vendorId).toBe("vendor-1");
    // Only GB is in the whitelist — US is disabled and must not leak through
    // just because no explicit country was asked for.
    expect(call.where.vendor.marketAssignments.some.marketCode.in).toEqual(["GB"]);
  });

  it("a two-market vendor (GB + FR, both enabled) is discoverable via either market code — 'inherit all active vendor markets' model", async () => {
    listMarketConfigs.mockResolvedValue([
      { countryCode: "GB", regularDeliveriesEnabled: true },
      { countryCode: "FR", regularDeliveriesEnabled: true },
    ] as never);
    m.subscriptionOffer.findMany.mockResolvedValue([] as never);

    await subscriptionOffersService.listPublic({});

    const call = m.subscriptionOffer.findMany.mock.calls[0][0] as {
      where: { vendor: { marketAssignments: { some: { marketCode: { in: string[] } } } } };
    };
    // Browsing with no filter offers the full enabled set as the match
    // list — a vendor assigned to either GB or FR (or both) will match via
    // the `some` relation filter, without collapsing into one vendor field.
    expect(call.where.vendor.marketAssignments.some.marketCode.in.sort()).toEqual(["FR", "GB"]);
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
