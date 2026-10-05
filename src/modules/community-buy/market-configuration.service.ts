import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { resolveMarketCode } from "../../shared/currency";
import { isIndividualDeliveryEnabled } from "./community-buy-privacy.service";
import { notificationsService } from "../notifications/notifications.service";
import { adminRolesService } from "../admin/admin-roles.service";

/**
 * Every market approved for the current launch scope. Africa is
 * deliberately absent: the client requires it built-but-not-launched, and
 * this list controls exactly what a fresh/QA database seeds. Africa (or any
 * other market) can now be added later WITHOUT a migration through
 * marketConfigurationService.createMarket() (POST /admin/community-buy/markets).
 *
 * Client decision (2026-09-22, "EKI — FINAL PRODUCTION CLOSURE", item 1):
 * launch scope = GB/US/CA + EVERY country classified as Europe (see
 * shared/currency.ts MARKET_CODE_COUNTRY_NAMES for the methodology and
 * exclusions; that table must be kept in sync with this one).
 *
 * communityBuyEnabled/organiserApplicationsEnabled/supplierApplicationsEnabled
 * default true for a market in this list. communityBuyPaymentsEnabled is NO
 * LONGER defaulted on (handbook 14.9): it requires verified readiness and a
 * Super Administrator. communityBuyPaymentMode is pinned to
 * PLEDGE_THEN_CHARGE, the only client-approved mode.
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
  { countryCode: "DE", currency: "EUR" },
  { countryCode: "NL", currency: "EUR" },
  { countryCode: "AT", currency: "EUR" },
  { countryCode: "IE", currency: "EUR" },
  { countryCode: "LU", currency: "EUR" },
  { countryCode: "GR", currency: "EUR" },
  { countryCode: "CY", currency: "EUR" },
  { countryCode: "MT", currency: "EUR" },
  { countryCode: "SI", currency: "EUR" },
  { countryCode: "SK", currency: "EUR" },
  { countryCode: "EE", currency: "EUR" },
  { countryCode: "LV", currency: "EUR" },
  { countryCode: "LT", currency: "EUR" },
  { countryCode: "FI", currency: "EUR" },
  { countryCode: "PL", currency: "PLN" },
  { countryCode: "CZ", currency: "CZK" },
  { countryCode: "HU", currency: "HUF" },
  { countryCode: "RO", currency: "RON" },
  { countryCode: "BG", currency: "BGN" },
  { countryCode: "DK", currency: "DKK" },
  { countryCode: "SE", currency: "SEK" },
  { countryCode: "NO", currency: "NOK" },
  { countryCode: "IS", currency: "ISK" },
  { countryCode: "LI", currency: "CHF" },
  { countryCode: "MC", currency: "EUR" },
  { countryCode: "AD", currency: "EUR" },
  { countryCode: "SM", currency: "EUR" },
  { countryCode: "BA", currency: "BAM" },
  { countryCode: "RS", currency: "RSD" },
  { countryCode: "ME", currency: "EUR" },
  { countryCode: "MK", currency: "MKD" },
  { countryCode: "AL", currency: "ALL" },
  { countryCode: "MD", currency: "MDL" },
];

const APPROVED_LAUNCH_MARKET_DEFAULTS = {
  communityBuyEnabled: true,
  organiserApplicationsEnabled: true,
  supplierApplicationsEnabled: true,
  // Handbook 14.9: a fresh/QA database must NOT pre-enable payments or mark
  // the rail LIVE - that needs verified readiness evidence and a Super
  // Administrator (see setPaymentsEnabled()). Already-live production rows
  // are handled by migration 20261002140900 (kept enabled, flagged
  // readinessUnverified), never by this seed.
  communityBuyPaymentsEnabled: false,
  communityBuyPaymentMode: "PLEDGE_THEN_CHARGE" as const,
  paymentProvider: "stripe",
  paymentMode: "DISABLED" as const,
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
 * every authenticated/internal caller.
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
  // not a per-market column; identical for every country.
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

// ─── Handbook 14.9 helpers ──────────────────────────────────────────────

const BOOLEAN_FIELDS = [
  "communityBuyEnabled",
  "organiserApplicationsEnabled",
  "supplierApplicationsEnabled",
  // regularDeliveriesEnabled drives the customer-facing "Foodstuffs Subscription" feature.
  "regularDeliveriesEnabled",
] as const;
const NULLABLE_STRING_FIELDS = ["paymentProvider", "identityProvider", "refundTermsVersion", "legalTermsVersion"] as const;
const NULLABLE_INT_FIELDS = ["campaignMinDurationHours", "campaignMaxDurationHours", "campaignMinValueAmount", "campaignMaxValueAmount", "organiserFeeBps"] as const;
const INT_BPS_FIELDS = ["communityBuyFeeBps", "organiserCommissionBps", "buyerServiceFeeBps"] as const;
const INT_AMOUNT_FIELDS = ["buyerServiceFeeMinAmount", "buyerServiceFeeMaxAmount"] as const;
const ENUMS = {
  paymentMode: ["DISABLED", "TEST", "LIVE"],
  supplierReleasePolicy: ["ON_DELIVERY_CONFIRMED", "ON_FULFILMENT_MARKED", "MANUAL_ADMIN_RELEASE"],
  communityBuyPaymentMode: ["PLEDGE_THEN_CHARGE", "AUTHORISE_THEN_CAPTURE"],
} as const;
const STRING_ARRAY_FIELDS = ["acceptedIdentityDocuments", "deliveryMethods"] as const;
/** Fields that must never be set through the generic update: they have guarded paths or are identity/system columns. */
const GUARDED_FIELDS = new Set([
  "communityBuyPaymentsEnabled", "providerSupported", "providerConfigChecked", "legalApprovalRef", "refundTested",
  "testTransactionAt", "readinessApprovedById", "readinessApprovedAt", "enablementReason", "readinessUnverified",
  "countryCode", "currency", "id", "createdAt", "updatedAt",
]);

export function normaliseCode(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(raw)) throw new AppError("countryCode must be a 2-letter ISO 3166-1 code", 400);
  return raw;
}

/** Whitelist + type-check the generic market settings update. Exported for tests. */
export function sanitiseMarketUpdate(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("Request body must be an object", 400);
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const known = new Set<string>([
    ...BOOLEAN_FIELDS, ...NULLABLE_STRING_FIELDS, ...NULLABLE_INT_FIELDS, ...INT_BPS_FIELDS, ...INT_AMOUNT_FIELDS,
    ...STRING_ARRAY_FIELDS, ...Object.keys(ENUMS),
  ]);
  for (const key of Object.keys(input)) {
    if (key === "reason") continue; // consumed by the controller for audit
    if (GUARDED_FIELDS.has(key)) {
      if (key === "communityBuyPaymentsEnabled") {
        throw new AppError("Community Buy payments are changed through the dedicated payments endpoint (Super Administrator only)", 403, null, "USE_PAYMENTS_ENDPOINT");
      }
      throw new AppError(`${key} cannot be changed through this endpoint`, 400);
    }
    if (!known.has(key)) throw new AppError(`Unknown field: ${key}`, 400);
  }
  for (const key of BOOLEAN_FIELDS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new AppError(`${key} must be a boolean`, 400);
    out[key] = input[key];
  }
  for (const key of NULLABLE_STRING_FIELDS) {
    if (input[key] === undefined) continue;
    if (input[key] !== null && typeof input[key] !== "string") throw new AppError(`${key} must be a string or null`, 400);
    const trimmed = typeof input[key] === "string" ? (input[key] as string).trim() : "";
    out[key] = trimmed ? trimmed.slice(0, 100) : null;
  }
  for (const key of NULLABLE_INT_FIELDS) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (v !== null && (!Number.isInteger(v) || (v as number) < 0)) throw new AppError(`${key} must be a non-negative integer or null`, 400);
    out[key] = v;
  }
  for (const key of INT_BPS_FIELDS) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 10_000) throw new AppError(`${key} must be an integer between 0 and 10000 (basis points)`, 400);
    out[key] = v;
  }
  for (const key of INT_AMOUNT_FIELDS) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (!Number.isInteger(v) || (v as number) < 0) throw new AppError(`${key} must be a non-negative integer`, 400);
    out[key] = v;
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (key === "communityBuyPaymentMode" && value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new AppError(`${key} must be one of ${allowed.join(", ")}`, 400);
    out[key] = value;
  }
  for (const key of STRING_ARRAY_FIELDS) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) throw new AppError(`${key} must be an array of strings`, 400);
    out[key] = [...new Set((v as string[]).map((item) => item.trim()).filter(Boolean))].slice(0, 50);
  }
  return out;
}

type MarketLike = {
  communityBuyEnabled: boolean;
  communityBuyPaymentsEnabled: boolean;
  organiserApplicationsEnabled: boolean;
  supplierApplicationsEnabled: boolean;
  regularDeliveriesEnabled: boolean;
  paymentMode: string;
  paymentProvider: string | null;
};

/**
 * Dependency validation (handbook 14.9). Only dependencies touched by this
 * request are checked, so an unrelated edit is never blocked by a legacy row
 * that already violates a rule.
 */
export function assertDependencies(existing: MarketLike, changes: Record<string, unknown>): void {
  const next = { ...existing, ...changes } as MarketLike;
  const touched = (k: string) => k in changes;
  if ((touched("communityBuyEnabled") || touched("organiserApplicationsEnabled") || touched("supplierApplicationsEnabled")) && !next.communityBuyEnabled) {
    const dependents = [
      next.organiserApplicationsEnabled ? "organiser applications" : null,
      next.supplierApplicationsEnabled ? "supplier applications" : null,
      next.communityBuyPaymentsEnabled ? "Community Buy payments" : null,
    ].filter(Boolean);
    if (dependents.length > 0) {
      throw new AppError(`Community Buy must stay enabled while these are on: ${dependents.join(", ")}. Disable them first.`, 409, { dependents }, "MARKET_DEPENDENCY");
    }
  }
  if ((touched("regularDeliveriesEnabled") || touched("paymentProvider") || touched("paymentMode")) && next.regularDeliveriesEnabled) {
    if (!next.paymentProvider || next.paymentMode === "DISABLED") {
      throw new AppError("Foodstuffs Subscriptions need a recurring payments provider: set a payment provider and a payment mode other than DISABLED first.", 409, null, "MARKET_DEPENDENCY");
    }
  }
}

export interface ReadinessItem {
  key: string;
  label: string;
  satisfied: boolean;
  detail?: string | null;
}

export function getReadiness(config: {
  providerSupported: boolean;
  providerConfigChecked: boolean;
  legalApprovalRef: string | null;
  refundTested: boolean;
  testTransactionAt: Date | null;
  readinessUnverified?: boolean;
}): { ready: boolean; items: ReadinessItem[]; unverified: boolean } {
  const items: ReadinessItem[] = [
    { key: "providerSupported", label: "Payment provider supports this country", satisfied: Boolean(config.providerSupported) },
    { key: "providerConfigChecked", label: "Provider configuration checked", satisfied: Boolean(config.providerConfigChecked) },
    { key: "legalApprovalRef", label: "Legal / terms approval recorded", satisfied: Boolean(config.legalApprovalRef?.trim()), detail: config.legalApprovalRef ?? null },
    { key: "refundTested", label: "Refund flow tested", satisfied: Boolean(config.refundTested) },
    { key: "testTransactionAt", label: "Test transaction completed", satisfied: Boolean(config.testTransactionAt), detail: config.testTransactionAt ? config.testTransactionAt.toISOString() : null },
  ];
  return { ready: items.every((i) => i.satisfied), items, unverified: Boolean(config.readinessUnverified) };
}

/** Super Administrator = holder of the full-access "admin.*" permission through an assigned role. */
export async function assertSuperAdmin(userId: string): Promise<void> {
  const permissions = await adminRolesService.userPermissions(userId);
  if (!permissions.includes("admin.*")) {
    throw new AppError("Only a Super Administrator can enable Community Buy payments for a market", 403, null, "SUPER_ADMIN_REQUIRED");
  }
}

const ACTIVE_CAMPAIGN_STATUSES = ["LIVE", "PAUSED", "RESCUE_WINDOW", "HOLD_WINDOW", "DECISION_REQUIRED", "FULFILLING", "PAYMENT_CAPTURE"] as const;

/** Best-effort, never throws. Existing campaigns are preserved - this only informs organisers and participants. */
async function notifyMarketChange(countryCode: string, event: "payments_disabled" | "market_disabled"): Promise<void> {
  try {
    const campaigns = await prisma.communityCampaign.findMany({
      where: { status: { in: [...ACTIVE_CAMPAIGN_STATUSES] } },
      select: { id: true, title: true, country: true, organiser: { select: { userId: true } }, participants: { select: { userId: true } } },
    });
    const day = new Date().toISOString().slice(0, 10);
    for (const c of campaigns) {
      if (resolveMarketCode(c.country) !== countryCode) continue;
      const body = event === "payments_disabled"
        ? `New payments for ${c.title} are temporarily paused in this market. Your existing commitment is unchanged and we will keep you updated.`
        : `Community Buy is temporarily unavailable in this market. ${c.title} is unchanged and we will keep you updated.`;
      const recipients = new Set<string>([c.organiser.userId, ...c.participants.map((p) => p.userId)]);
      for (const userId of recipients) {
        await notificationsService.enqueue({
          userId,
          type: "COMMUNITY_CAMPAIGN_UPDATE",
          title: "Market availability update",
          body,
          data: { type: "community_campaign_update", event, campaignId: c.id },
          dedupeKey: `${event}:${countryCode}:${c.id}:${userId}:${day}`,
        });
      }
    }
  } catch (error) {
    logger.error("Market change notification failed (non-blocking)", { countryCode, event, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

export const marketConfigurationService = {
  /**
   * Cheap fast-path for the hot call sites (get()/list(), including the
   * per-pledge isCommunityBuyPaymentsEnabled check) — only pays for the
   * upsert loop on a genuinely empty table (fresh QA/test DB).
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
   * free-text country representation ("United Kingdom", "UK", "gb", ...) —
   * normalizes through resolveMarketCode() first.
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

  /**
   * Handbook 14.9 - whitelisted settings update. Unknown/guarded keys are
   * rejected (never forwarded to Prisma); readiness and the payments flag
   * have their own guarded paths (setReadiness()/setPaymentsEnabled()).
   */
  async update(countryCode: string, rawData: unknown) {
    await this.ensureDefaults();
    const code = normaliseCode(countryCode);
    const existing = await prisma.marketConfiguration.findUnique({ where: { countryCode: code } });
    if (!existing) throw new AppError("Market not found", 404);
    const data = sanitiseMarketUpdate(rawData);
    if (Object.keys(data).length === 0) throw new AppError("No updatable fields supplied", 400);
    assertDependencies(existing, data);
    const updated = await prisma.marketConfiguration.update({ where: { countryCode: code }, data });
    if (existing.communityBuyEnabled && !updated.communityBuyEnabled) {
      void notifyMarketChange(code, "market_disabled");
    }
    return updated;
  },

  /** Handbook 14.9 - add a market without a migration. Everything starts disabled; no payment readiness. */
  async createMarket(input: { countryCode: unknown; currency: unknown }) {
    const code = normaliseCode(input.countryCode);
    const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("currency must be a 3-letter ISO 4217 code", 400);
    const existing = await prisma.marketConfiguration.findUnique({ where: { countryCode: code } });
    if (existing) throw new AppError("This market already exists", 409);
    return prisma.marketConfiguration.create({ data: { countryCode: code, currency, paymentMode: "DISABLED" } });
  },

  /** Verified payment readiness checklist (separate from the feature toggles). */
  getReadiness,

  /**
   * Handbook 14.9 - record readiness evidence. Super Administrator only
   * (the controller calls assertSuperAdmin). Approval metadata is only
   * stamped when every item is satisfied; a regression re-flags an already
   * enabled market as "readiness unverified" but never silently disables payments.
   */
  async setReadiness(countryCode: string, rawInput: unknown, actorId: string) {
    await this.ensureDefaults();
    const code = normaliseCode(countryCode);
    const existing = await prisma.marketConfiguration.findUnique({ where: { countryCode: code } });
    if (!existing) throw new AppError("Market not found", 404);
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const key of ["providerSupported", "providerConfigChecked", "refundTested"] as const) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== "boolean") throw new AppError(`${key} must be a boolean`, 400);
        data[key] = input[key];
      }
    }
    if (input.legalApprovalRef !== undefined) {
      if (input.legalApprovalRef !== null && typeof input.legalApprovalRef !== "string") throw new AppError("legalApprovalRef must be a string", 400);
      const ref = typeof input.legalApprovalRef === "string" ? input.legalApprovalRef.trim() : "";
      data.legalApprovalRef = ref ? ref.slice(0, 200) : null;
    }
    if (input.testTransactionAt !== undefined) {
      if (input.testTransactionAt === null) {
        data.testTransactionAt = null;
      } else {
        const d = new Date(String(input.testTransactionAt));
        if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 60_000) throw new AppError("testTransactionAt must be a valid past date", 400);
        data.testTransactionAt = d;
      }
    }
    if (Object.keys(data).length === 0) throw new AppError("No readiness fields supplied", 400);
    const checklist = getReadiness({ ...existing, ...data } as typeof existing);
    if (checklist.ready) {
      data.readinessApprovedById = actorId;
      data.readinessApprovedAt = new Date();
      data.readinessUnverified = false;
    } else {
      data.readinessApprovedById = null;
      data.readinessApprovedAt = null;
      if (existing.communityBuyPaymentsEnabled) data.readinessUnverified = true;
    }
    return prisma.marketConfiguration.update({ where: { countryCode: code }, data });
  },

  /**
   * Handbook 14.9 / user decision - ONLY a Super Administrator may enable
   * Community Buy payments, and only with complete readiness evidence, a
   * reason and an approval reference. 2FA is enforced at the route layer.
   * Disabling is allowed for any community_buy.mutate admin (a kill switch
   * must never be harder to pull than to push) but still needs a reason.
   */
  async setPaymentsEnabled(countryCode: string, enable: boolean, ctx: { actorId: string; reason: string; approvalRef?: string | null }) {
    await this.ensureDefaults();
    const code = normaliseCode(countryCode);
    const existing = await prisma.marketConfiguration.findUnique({ where: { countryCode: code } });
    if (!existing) throw new AppError("Market not found", 404);
    const reason = (ctx.reason ?? "").trim();
    if (reason.length < 5) throw new AppError("A reason of at least 5 characters is required", 400);
    if (enable) {
      await assertSuperAdmin(ctx.actorId);
      const approvalRef = (ctx.approvalRef ?? "").trim();
      if (approvalRef.length < 3) throw new AppError("An approval reference is required to enable payments", 400);
      if (!existing.communityBuyEnabled) throw new AppError("Community Buy must be enabled for this market before payments can be enabled", 409, null, "MARKET_DEPENDENCY");
      const checklist = getReadiness(existing);
      if (!checklist.ready) {
        throw new AppError("Payment readiness is incomplete for this market", 409, { missing: checklist.items.filter((i) => !i.satisfied).map((i) => i.key) }, "MARKET_READINESS_INCOMPLETE");
      }
      return prisma.marketConfiguration.update({
        where: { countryCode: code },
        data: {
          communityBuyPaymentsEnabled: true,
          enablementReason: `${reason} (approval: ${approvalRef})`,
          readinessApprovedById: ctx.actorId,
          readinessApprovedAt: new Date(),
          readinessUnverified: false,
        },
      });
    }
    const updated = await prisma.marketConfiguration.update({
      where: { countryCode: code },
      data: { communityBuyPaymentsEnabled: false, enablementReason: reason },
    });
    // Existing campaigns/subscriptions are preserved; only inform affected people (best effort).
    void notifyMarketChange(code, "payments_disabled");
    return updated;
  },

  /** Feature-evaluation helper (architecture doc §8) — a market with paymentMode DISABLED must never accept a Community Buy payment, regardless of the communityBuyPaymentsEnabled flag above (that flag is the product toggle; this is the rail-readiness gate). */
  async isPaymentRailLive(countryCode: string): Promise<boolean> {
    const config = await this.get(countryCode);
    return config?.paymentMode === "LIVE" && Boolean(config.paymentProvider);
  },

  /**
   * Client mandate (2026-09): "if a market has no explicit approved payment
   * mode, disable Community Buy payment there." PLEDGE_THEN_CHARGE and
   * AUTHORISE_THEN_CAPTURE are both real, implemented modes; the client
   * explicitly rejected PAY_NOW_REFUND_ON_FAILURE, which stays blocked.
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
   * AUTHORISE_THEN_CAPTURE. Never used after creation.
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
