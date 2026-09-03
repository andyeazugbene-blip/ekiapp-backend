import type { CommunityBuyPaymentMode, MarketPaymentMode, SupplierReleasePolicy } from "@prisma/client";

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
    // Architecture doc §8 fields — schema-ready, added in the A→Z pass.
    // paymentProvider/identityProvider are free-text on purpose: this
    // codebase supports exactly "stripe"/"paystack" and "stripe_identity"
    // today, but hardcoding an enum here would need a migration for every
    // future provider. Validate against the known set at the call site
    // that reads it, not here.
    paymentMode: MarketPaymentMode;
    paymentProvider: string | null;
    identityProvider: string | null;
    acceptedIdentityDocuments: string[];
    campaignMinDurationHours: number | null;
    campaignMaxDurationHours: number | null;
    campaignMinValueAmount: number | null;
    campaignMaxValueAmount: number | null;
    refundTermsVersion: string | null;
    organiserFeeBps: number | null;
    supplierReleasePolicy: SupplierReleasePolicy;
    deliveryMethods: string[];
    legalTermsVersion: string | null;
    communityBuyPaymentMode: CommunityBuyPaymentMode | null;
    // Client mandate (2026-09): Eki's configured processing/commission fee,
    // taken at supplier-payment release time. No default — see schema note.
    communityBuyFeeBps: number | null;
  }>) {
    await this.ensureDefaults();
    return prisma.marketConfiguration.update({ where: { countryCode }, data });
  },

  /** Feature-evaluation helper (architecture doc §8) — a market with paymentMode DISABLED must never accept a Community Buy payment, regardless of the communityBuyPaymentsEnabled flag above (that flag is the product toggle; this is the rail-readiness gate). */
  async isPaymentRailLive(countryCode: string): Promise<boolean> {
    const config = await this.get(countryCode);
    return config?.paymentMode === "LIVE" && Boolean(config.paymentProvider);
  },

  /**
   * Client mandate (2026-09): "if a market has no explicit approved payment
   * mode, disable Community Buy payment there." PLEDGE_THEN_CHARGE is now
   * the one implemented mode (campaign-contributions.service.ts) — the
   * client explicitly rejected the earlier PAY_NOW_REFUND_ON_FAILURE model
   * ("Do NOT implement pay-now-then-refund"). A market still set to
   * PAY_NOW_REFUND_ON_FAILURE or AUTHORISE_THEN_CAPTURE is correctly
   * blocked too, not silently routed through the wrong flow. No production
   * market had payments enabled before this change (verified via the
   * required flags being off/null everywhere), so repointing this gate is
   * safe — nothing live is being switched underneath a real user.
   */
  async isCommunityBuyPaymentsEnabled(countryCode: string): Promise<boolean> {
    const config = await this.get(countryCode);
    return Boolean(
      config?.communityBuyEnabled
      && config?.communityBuyPaymentsEnabled
      && config.communityBuyPaymentMode === "PLEDGE_THEN_CHARGE",
    );
  },
};

export { INITIAL_MARKETS };
