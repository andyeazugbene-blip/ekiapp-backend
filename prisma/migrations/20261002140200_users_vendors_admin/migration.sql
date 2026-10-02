-- Users & Vendors admin (handbook 4.3, 14.5, 14.7)
-- Vendor: products switched off by a suspension, restored by the matching unsuspend.
ALTER TABLE "Vendor" ADD COLUMN     "suspensionDisabledProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: accounts scrubbed by the legacy anonymise paths carry a marker email.
UPDATE "User"
SET "anonymisedAt" = "updatedAt"
WHERE "anonymisedAt" IS NULL
  AND "email" LIKE 'deleted\_%@anonymized.local';
