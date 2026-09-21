-- Client decision (2026-09-22, "FINAL CLIENT DECISIONS — APPLY NOW"):
-- enable Community Buy for the existing approved non-Africa launch markets
-- (GB, US, CA + the 7 European markets already seeded by the
-- 20260903190000_expand_approved_markets migration) using the real
-- MarketConfiguration flags already enforced by
-- marketConfigurationService.isCommunityBuyPaymentsEnabled() and the
-- organiser/supplier application gates. Africa is deliberately absent from
-- this list and stays unconfigured (no row exists for any African
-- country), exactly as market-configuration.service.ts's INITIAL_MARKETS
-- comment already documents as the correct way to keep it unavailable.
--
-- UPSERT, not a plain UPDATE: this migration's own dry run against a real
-- Postgres instance found that GB/US/CA rows do not reliably exist yet —
-- ensureDefaults() only auto-seeds on a genuinely EMPTY table, and once the
-- 7-European-market expansion migration (or any other write) had already
-- put rows in the table, GB/US/CA's runtime seed path never fires. A plain
-- UPDATE ... WHERE countryCode IN (...) would silently no-op on whichever
-- of the ten rows don't exist yet — exactly the kind of "looks applied but
-- isn't" bug this whole change is trying to avoid. INSERT ... ON CONFLICT
-- DO UPDATE guarantees all ten rows end up in the enabled state regardless
-- of what existed before.
--
-- paymentProvider='stripe'/paymentMode='LIVE' reflect production reality
-- (confirmed live via /api/health/detailed) — Stripe's platform account is
-- what PLEDGE_THEN_CHARGE charges against for buyer-side pledges, which
-- needs no per-market Stripe Connect setup. identityProvider='stripe_identity'
-- reflects the one real, implemented verification provider
-- (stripeIdentityService). communityBuyPaymentMode is explicitly pinned to
-- PLEDGE_THEN_CHARGE — the only client-approved mode; AUTHORISE_THEN_CAPTURE
-- stays available in the schema for a future market but is never activated
-- here.
--
-- Deliberately NOT touched by this migration (separate, still-pending
-- decisions — see the four COMMUNITY_BUY_*_CONFIRMED/_ENABLED env gates):
-- supplier/organiser payout custody, organiser-fee settlement, and
-- individual-delivery PII exposure. Those remain OFF regardless of this
-- change, and this migration does not reference them.
--
-- Also NOT touched: regularDeliveriesEnabled (the ordinary, non-Community-
-- Buy marketplace's own per-market flag) — this decision was scoped
-- explicitly to Community Buy launch availability only. An existing row's
-- current value for it is preserved on conflict (excluded from the DO
-- UPDATE SET list); a newly-inserted row gets the column's own schema
-- default (false), same as every other market row.
INSERT INTO "MarketConfiguration" (
  "id", "countryCode", "currency",
  "communityBuyEnabled", "organiserApplicationsEnabled", "supplierApplicationsEnabled",
  "communityBuyPaymentsEnabled", "communityBuyPaymentMode",
  "paymentProvider", "paymentMode", "identityProvider",
  "createdAt", "updatedAt"
)
VALUES
  ('market_config_gb', 'GB', 'GBP', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_us', 'US', 'USD', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ca', 'CA', 'CAD', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_fr_v2', 'FR', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_es_v2', 'ES', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_pt_v2', 'PT', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ch_v2', 'CH', 'CHF', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_be_v2', 'BE', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_it_v2', 'IT', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_hr_v2', 'HR', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("countryCode") DO UPDATE SET
  "communityBuyEnabled" = true,
  "organiserApplicationsEnabled" = true,
  "supplierApplicationsEnabled" = true,
  "communityBuyPaymentsEnabled" = true,
  "communityBuyPaymentMode" = 'PLEDGE_THEN_CHARGE',
  "paymentProvider" = 'stripe',
  "paymentMode" = 'LIVE',
  "identityProvider" = 'stripe_identity',
  "updatedAt" = CURRENT_TIMESTAMP;
