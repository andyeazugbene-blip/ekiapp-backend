-- Client decision (2026-09-22, "EKI — FINAL PRODUCTION CLOSURE", item 2):
-- PRICE_APPROVAL_TIMEOUT_HOURS / FULFILMENT_STALE_THRESHOLD_HOURS /
-- PAYOUT_STUCK_THRESHOLD_HOURS now default to 1 (hour) instead of being
-- unconfigured. adminPlatformSettingsService.ensureDefaults() (see
-- admin-platform-settings.service.ts) already seeds this same default of 1
-- lazily, on the first getValue()/list() call after this deploy — this
-- migration exists only so an already-running production environment gets
-- the default immediately at deploy time, not only after its next request
-- happens to call one of those functions (e.g. a cron job that runs on a
-- schedule and might otherwise wait up to its own interval before it's
-- first invoked post-deploy).
--
-- INSERT ... ON CONFLICT ("key") DO NOTHING: this is the safety-critical
-- part of this migration. It must NEVER overwrite an admin's real
-- already-configured value with the default — a plain INSERT would violate
-- the unique constraint on an existing key (failing the whole migration),
-- and an UPSERT-with-overwrite would silently clobber a real production
-- value back down to 1 every time this migration file is deployed to a
-- fresh environment that happens to already have that key configured (e.g.
-- restoring a production snapshot into a new environment). DO NOTHING is
-- the only behavior that satisfies both "new/unconfigured environments get
-- 1" and "an already-configured value is never touched."
--
-- updatedById intentionally left NULL — this is a system-seeded default,
-- not an action any specific admin took, exactly mirroring how
-- AdminPlatformSetting.updatedById is already nullable for this reason.
INSERT INTO "AdminPlatformSetting" ("id", "key", "value", "updatedById", "createdAt", "updatedAt")
VALUES
  ('admin_platform_setting_price_approval_timeout_hours', 'PRICE_APPROVAL_TIMEOUT_HOURS', 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('admin_platform_setting_fulfilment_stale_threshold_hours', 'FULFILMENT_STALE_THRESHOLD_HOURS', 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('admin_platform_setting_payout_stuck_threshold_hours', 'PAYOUT_STUCK_THRESHOLD_HOURS', 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
