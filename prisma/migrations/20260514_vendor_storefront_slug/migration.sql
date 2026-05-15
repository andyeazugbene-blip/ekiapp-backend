-- Phase: Public vendor storefront links
-- Adds storeSlug (unique), avatar, coverImage to Vendor.
-- Backfills storeSlug from storeName for existing rows, ensuring uniqueness.

-- 1. Add columns as nullable first so we can backfill safely.
ALTER TABLE "Vendor" ADD COLUMN "storeSlug" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "avatar" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "coverImage" TEXT;

-- 2. Backfill storeSlug for existing rows.
--    a) Build a base slug from storeName (lowercase, alphanumeric+hyphen).
--    b) Disambiguate duplicates by appending the row number per base.
WITH normalized AS (
  SELECT
    id,
    storeName,
    NULLIF(
      regexp_replace(
        regexp_replace(lower(storeName), '[^a-z0-9]+', '-', 'g'),
        '(^-+|-+$)', '', 'g'
      ),
      ''
    ) AS base
  FROM "Vendor"
),
ranked AS (
  SELECT
    id,
    COALESCE(base, 'store') AS base,
    ROW_NUMBER() OVER (PARTITION BY COALESCE(base, 'store') ORDER BY id) AS rn
  FROM normalized
)
UPDATE "Vendor" v
SET "storeSlug" = CASE WHEN r.rn = 1 THEN r.base ELSE r.base || '-' || r.rn END
FROM ranked r
WHERE v.id = r.id;

-- 3. Enforce NOT NULL and uniqueness once backfill is complete.
ALTER TABLE "Vendor" ALTER COLUMN "storeSlug" SET NOT NULL;
CREATE UNIQUE INDEX "Vendor_storeSlug_key" ON "Vendor" ("storeSlug");

-- 4. Add index for suspension filtering on public lookups.
CREATE INDEX "Vendor_isSuspended_idx" ON "Vendor" ("isSuspended");
