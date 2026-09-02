import { prisma } from "../../lib/prisma";

/**
 * Every market Community Buy could plausibly launch in first (per the
 * client's own spec §10 and §8.2: UK, USA, Canada, and country-by-country
 * European markets). All flags default OFF — see the schema-level note on
 * MarketConfiguration. Turning any of these on for a given country is a
 * deliberate admin action, gated on the legal/payment-provider review the
 * client's spec requires (§8.4), not something this codebase decides.
 */
const INITIAL_MARKETS = ["GB", "US", "CA"];

async function ensure(countryCode: string, currency: string) {
  await prisma.marketConfiguration.upsert({
    where: { countryCode },
    update: {},
    create: { countryCode, currency },
  });
}

export const marketConfigurationService = {
  async ensureDefaults(): Promise<void> {
    const existing = await prisma.marketConfiguration.count();
    if (existing > 0) return;
    await ensure("GB", "GBP");
    await ensure("US", "USD");
    await ensure("CA", "CAD");
  },

  async get(countryCode: string) {
    await this.ensureDefaults();
    return prisma.marketConfiguration.findUnique({ where: { countryCode } });
  },

  async list() {
    await this.ensureDefaults();
    return prisma.marketConfiguration.findMany({ orderBy: { countryCode: "asc" } });
  },

  async update(countryCode: string, data: Partial<{
    communityBuyEnabled: boolean;
    communityBuyPaymentsEnabled: boolean;
    organiserApplicationsEnabled: boolean;
    supplierApplicationsEnabled: boolean;
    regularDeliveriesEnabled: boolean;
  }>) {
    await this.ensureDefaults();
    return prisma.marketConfiguration.update({ where: { countryCode }, data });
  },

  async isCommunityBuyPaymentsEnabled(countryCode: string): Promise<boolean> {
    const config = await this.get(countryCode);
    return Boolean(config?.communityBuyEnabled && config?.communityBuyPaymentsEnabled);
  },
};

export { INITIAL_MARKETS };
