-- Client decision (2026-09-22, "EKI — FINAL PRODUCTION CLOSURE", item 1):
-- expand Community Buy launch scope from GB/US/CA + 7 European markets to
-- GB/US/CA + EVERY country classified as Europe. GB/US/CA and the original
-- 7 European markets are untouched by this migration (already enabled by
-- 20260921230255_community_buy_launch_markets_enable) — this migration
-- only inserts the 33 newly-approved European markets.
--
-- No broader "Europe" registry existed anywhere in this codebase before
-- this change (shipping/delivery-zone config, currency resolution, vendor/
-- organiser market-assignment code were all checked) — this list is a
-- standard, defensible European-sovereign-state set (UN M49 "Europe"
-- region), restricted to countries with a real ISO 3166-1 alpha-2 code and
-- a currency Stripe actually processes (STRIPE_SUPPORTED_CURRENCIES in
-- src/shared/currency.ts). Russia (RUB), Belarus (BYN) and Ukraine (UAH)
-- are excluded: none of their currencies is Stripe-supported, and Russia/
-- Belarus are additionally under active international sanctions while
-- Ukraine remains in active conflict. Kosovo is excluded for lacking a
-- standard ISO 3166-1 alpha-2 code. Vatican City is excluded as having no
-- realistic resident/commercial population. See
-- src/modules/community-buy/market-configuration.service.ts's
-- INITIAL_MARKETS and src/shared/currency.ts's MARKET_CODE_COUNTRY_NAMES
-- for the identical, single-source-of-truth list this migration mirrors.
--
-- Same UPSERT pattern as the prior market-enablement migration (INSERT ...
-- ON CONFLICT DO UPDATE, not a plain UPDATE) — guarantees every target row
-- ends up correctly configured regardless of whether it already existed
-- (e.g. a country's row created earlier by ensureDefaults() with different
-- flags, or genuinely absent).
--
-- paymentProvider='stripe'/paymentMode='LIVE'/identityProvider=
-- 'stripe_identity'/communityBuyPaymentMode='PLEDGE_THEN_CHARGE' mirror the
-- prior migration exactly — same production rails, same client-approved
-- payment mode, no new mechanism introduced.
--
-- Deliberately NOT touched by this migration (same as the prior one): the
-- four COMMUNITY_BUY_*_CONFIRMED/_ENABLED env gates (supplier/organiser
-- payout custody, organiser-fee settlement, individual-delivery PII
-- exposure) and regularDeliveriesEnabled.
INSERT INTO "MarketConfiguration" (
  "id", "countryCode", "currency",
  "communityBuyEnabled", "organiserApplicationsEnabled", "supplierApplicationsEnabled",
  "communityBuyPaymentsEnabled", "communityBuyPaymentMode",
  "paymentProvider", "paymentMode", "identityProvider",
  "createdAt", "updatedAt"
)
VALUES
  ('market_config_de', 'DE', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_nl', 'NL', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_at', 'AT', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ie', 'IE', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_lu', 'LU', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_gr', 'GR', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_cy', 'CY', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_mt', 'MT', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_si', 'SI', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_sk', 'SK', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ee', 'EE', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_lv', 'LV', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_lt', 'LT', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_fi', 'FI', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_pl', 'PL', 'PLN', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_cz', 'CZ', 'CZK', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_hu', 'HU', 'HUF', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ro', 'RO', 'RON', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_bg', 'BG', 'BGN', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_dk', 'DK', 'DKK', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_se', 'SE', 'SEK', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_no', 'NO', 'NOK', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_is', 'IS', 'ISK', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_li', 'LI', 'CHF', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_mc', 'MC', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ad', 'AD', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_sm', 'SM', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ba', 'BA', 'BAM', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_rs', 'RS', 'RSD', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_me', 'ME', 'EUR', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_mk', 'MK', 'MKD', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_al', 'AL', 'ALL', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_md', 'MD', 'MDL', true, true, true, true, 'PLEDGE_THEN_CHARGE', 'stripe', 'LIVE', 'stripe_identity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
