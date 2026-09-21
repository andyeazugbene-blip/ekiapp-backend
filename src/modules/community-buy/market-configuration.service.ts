import type { CommunityBuyPaymentMode, MarketPaymentMode, SupplierReleasePolicy } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { resolveMarketCode } from "../../shared/currency";
import { isIndividualDeliveryEnabled } from "./community-buy-privacy.service";

/**
 * Every market approved for the current launch scope (client mandate
 * 2026-09, section 5: "GB, US, CA and the approved European markets such
 * as France, Spain, Portugal, Switzerland, Belgium, Italy and Croatia" —
 * explicit, not silently added or removed). Africa is deliberately absent:
 * the client requires it built-but-not-launched, and this list controls
 * exactly what a fresh/QA database seeds — omission here, not a code gate,
 * is what keeps Africa unavailable (see market-controls admin UI).
 *
 * Client decision (2026-09-22, "FINAL CLIENT DECISIONS — APPLY NOW"):
 * Community Buy is now approved to launch in exactly these ten markets —
 * communityBuyEnabled/organiserApplicationsEnabled/
 * supplierApplicationsEnabled/communityBuyPaymentsEnabled all default true
 * for a market in this list. communityBuyPaymentMode is pinned to
 * PLEDGE_THEN_CHARGE, the only client-approved mode. paymentProvider/
 * paymentMode/identityProvider reflect production reality (Stripe live,
 * stripeIdentityService is the one real verification provider) — see
 * migrations/20260921230255_community_buy_launch_markets_enable for the
 * matching data migration that brings an already-existing (pre-decision)
 * database to this same state. regularDeliveriesEnabled (the ordinary,
 * non-Community-Buy marketplace's own flag) is untouched by this decision
 * — it was scoped to Community Buy launch availability only — and keeps
 * its column default (false) here exactly as before.
 */
const INITIAL_MARKETS: { countryCode: string; currency: string }[] = [
  { countryCode: "GB", currency: "GBP" },
  { countryCode: "US", currency: "USD" },
  { countryCode: "CA", currency: "CAD" },
  { countryCode: "FR", currency: "EUR" },
  { countryCode: "ES", currency: "EUR" },
  { countryCode: "PT", currency: "EUR" },
  { countryCode: "CH", currency: "CHF" },
  { countryCode: "BE", currency: "EUR" },
  { countryCode: "IT", currency: "EUR" },
  { countryCode: "HR", currency: "EUR" },
];

const APPROVED_LAUNCH_MARKET_DEFAULTS = {
  communityBuyEnabled: true,
  organiserApplicationsEnabled: true,
  supplierApplicationsEnabled: true,
  communityBuyPaymentsEnabled: true,
  communityBuyPaymentMode: "PLEDGE_THEN_CHARGE" as const,
  paymentProvider: "stripe",
  paymentMode: "LIVE" as const,
  identityProvider: "stripe_identity",
};

async function ensure(countryCode: string, currency: string) {
  await prisma.marketConfiguration.upsert({
    where: { countryCode },
    update: {},
    create: { countryCode, currency, ...APPROVED_LAUNCH_MARKET_DEFAULTS },
  });
}

/**
 * SEC-01 fix: the public, unauthenticated market endpoints must return only
 * the feature-gating flags the mobile app actually needs to decide whether
 * to show an entry point — not the full row `get()`/`list()` return for
 * every authenticated/internal caller (Eki's fee bps, live/test payment
 * mode, provider names, legal-terms versions, etc.). This shape is additive
 * to the public surface only; every internal caller keeps using `get()`/
 * `list()` unchanged.
 */
export interface PublicMarketConfiguration {
  countryCode: string;
  currency: string;
  communityBuyEnabled: boolean;
  communityBuyPaymentsEnabled: boolean;
  organiserApplicationsEnabled: boolean;
  supplierApplicationsEnabled: boolean;
  regularDeliveriesEnabled: boolean;
  // M4 — global kill-switch (COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED),
  // not a per-market MarketConfiguration column: reported here purely
  // because this is the existing "what can the app show right now" public
  // capability surface mobile already fetches before rendering the
  // creation/delivery step. The value is identical for every country.
  individualDeliveryEnabled: boolean;
}

function toPublicShape(config: {
  countryCode: string;
  currency: string;
  communityBuyEnabled: boolean;
  communityBuyPaymentsEnabled: boolean;
  organiserApplicationsEnabled: boolean;
  supplierApplicationsEnabled: boolean;
  regularDeliveriesEnabled: boolean;
}): PublicMarketConfiguration {
  return {
    countryCode: config.countryCode,
    currency: config.currency,
    communityBuyEnabled: config.communityBuyEnabled,
    communityBuyPaymentsEnabled: config.communityBuyPaymentsEnabled,
    organiserApplicationsEnabled: config.organiserApplicationsEnabled,
    supplierApplicationsEnabled: config.supplierApplicationsEnabled,
    regularDeliveriesEnabled: config.regularDeliveriesEnabled,
    individualDeliveryEnabled: isIndividualDeliveryEnabled(),
  };
}

export const marketConfigurationService = {
  /**
   * Cheap fast-path for the hot call sites (get()/list(), including the
   * per-pledge isCommunityBuyPaymentsEnabled check) — only pays for the
   * upsert loop on a genuinely empty table (fresh QA/test DB). Any market
   * added to INITIAL_MARKETS *after* a real environment already has rows
   * (e.g. the European markets added alongside GB/US/CA already existing
   * in production) is seeded once via a migration backfill instead —
   * see prisma/migrations/20260903190000_expand_approved_markets — not
   * by paying N extra upserts on every single request forever.
   */
  async ensureDefaults(): Promise<void> {
    const existing = await prisma.marketConfiguration.count();
    if (existing > 0) return;
    for (const market of INITIAL_MARKETS) {
      await ensure(market.countryCode, market.currency);
    }
  },

  /**
   * Accepts either a real MarketConfiguration.countryCode ("GB") or any raw
   * free-text country representation that might be stored on OrganiserProfile
   * .country / SupplierProfile.country / CommunityCampaign.country / Vendor
   * .country ("United Kingdom", "UK", "gb", ...) — normalizes through
   * resolveMarketCode() first. Previously this did a literal countryCode
   * lookup only, so every caller passing a full country name (which is what
   * request.body.country / campaign.country actually contain in real usage)
   * silently got null back and every gated action ("Community Buy is not
   * available in this market yet") incorrectly rejected even fully-enabled
   * markets.
   */
  async get(countryCode: string) {
    await this.ensureDefaults();
    const resolved = resolveMarketCode(countryCode) ?? countryCode.trim().toUpperCase();
    return prisma.marketConfiguration.findUnique({ where: { countryCode: resolved } });
  },

  async list() {
    await this.ensureDefaults();
    return prisma.marketConfiguration.findMany({ orderBy: { countryCode: "asc" } });
  },

  /** SEC-01: public/unauthenticated equivalent of list() — feature-gating flags only. */
  async listPublic(): Promise<PublicMarketConfiguration[]> {
    const configs = await this.list();
    return configs.map(toPublicShape);
  },

  /** SEC-01: public/unauthenticated equivalent of get() — feature-gating flags only. */
  async getPublic(countryCode: string): Promise<PublicMarketConfiguration | null> {
    const config = await this.get(countryCode);
    return config ? toPublicShape(config) : null;
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
    // Diaspora final V1 settlement doc §N — all four now have a real,
    // client-confirmed default (see schema notes) rather than being
    // unresolved; admin can still override per market.
    communityBuyFeeBps: number;
    organiserCommissionBps: number;
    buyerServiceFeeBps: number;
    buyerServiceFeeMinAmount: number;
    buyerServiceFeeMaxAmount: number;
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
   * mode, disable Community Buy payment there." PLEDGE_THEN_CHARGE
   * (campaign-contributions.service.ts) and, as of M2, AUTHORISE_THEN_CAPTURE
   * (campaign-authorisation.service.ts, spec §11) are both real, implemented
   * modes — the client explicitly rejected only the PAY_NOW_REFUND_ON_FAILURE
   * model ("Do NOT implement pay-now-then-refund"), which stays blocked. No
   * production market has payments enabled today (verified via the required
   * flags being off/null everywhere), so widening this gate is safe —
   * nothing live is being switched underneath a real user; flipping a
   * market to AUTHORISE_THEN_CAPTURE is a separate, deliberate admin action
   * gated on the external confirmations named in the M2 plan.
   */
  async isCommunityBuyPaymentsEnabled(countryCode: string): Promise<boolean> {
    const config = await this.get(countryCode);
    return Boolean(
      config?.communityBuyEnabled
      && config?.communityBuyPaymentsEnabled
      && (config.communityBuyPaymentMode === "PLEDGE_THEN_CHARGE" || config.communityBuyPaymentMode === "AUTHORISE_THEN_CAPTURE"),
    );
  },

  /**
   * M2 — resolves which payment mode a BRAND-NEW campaign should snapshot
   * (communityCampaignsService.create()) — PLEDGE_THEN_CHARGE unless the
   * market is both Community-Buy-enabled and explicitly configured for
   * AUTHORISE_THEN_CAPTURE. Never used after creation — see
   * CommunityCampaign.paymentMode's own doc comment for why the snapshot,
   * once taken, is never re-read from here again.
   */
  async resolveNewCampaignPaymentMode(countryCode: string): Promise<"PLEDGE_THEN_CHARGE" | "AUTHORISE_THEN_CAPTURE"> {
    const config = await this.get(countryCode);
    if (config?.communityBuyEnabled && config.communityBuyPaymentMode === "AUTHORISE_THEN_CAPTURE") {
      return "AUTHORISE_THEN_CAPTURE";
    }
    return "PLEDGE_THEN_CHARGE";
  },
};

export { INITIAL_MARKETS };
