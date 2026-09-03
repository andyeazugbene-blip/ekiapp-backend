-- Client mandate (2026-09), section 5: "Use the approved non-Africa markets
-- already defined in the project/client scope... GB, US, CA and the
-- approved European markets such as France, Spain, Portugal, Switzerland,
-- Belgium, Italy and Croatia." market-configuration.service.ts's
-- ensureDefaults() only seeds on a genuinely empty table, so a production/
-- QA database that already has GB/US/CA rows needs these new rows created
-- explicitly here rather than relying on that runtime seed path. All flags
-- default to their column defaults (everything OFF/null) — this is purely
-- "make the market configurable", never "enable" anything.
INSERT INTO "MarketConfiguration" ("id", "countryCode", "currency", "createdAt", "updatedAt")
VALUES
  ('market_config_fr', 'FR', 'EUR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_es', 'ES', 'EUR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_pt', 'PT', 'EUR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_ch', 'CH', 'CHF', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_be', 'BE', 'EUR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_it', 'IT', 'EUR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('market_config_hr', 'HR', 'EUR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("countryCode") DO NOTHING;
