-- Add Vendor.currency field with country-based backfill.

ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'EUR';

-- Backfill based on country
UPDATE "Vendor" SET "currency" = 'GBP' WHERE lower("country") IN ('uk', 'united kingdom', 'gb', 'england');
UPDATE "Vendor" SET "currency" = 'NGN' WHERE lower("country") IN ('nigeria', 'ng');
UPDATE "Vendor" SET "currency" = 'GHS' WHERE lower("country") IN ('ghana', 'gh');
UPDATE "Vendor" SET "currency" = 'KES' WHERE lower("country") IN ('kenya', 'ke');
UPDATE "Vendor" SET "currency" = 'ZAR' WHERE lower("country") IN ('south africa', 'za');
UPDATE "Vendor" SET "currency" = 'USD' WHERE lower("country") IN ('us', 'usa', 'united states');
-- Everything else stays EUR (default)
