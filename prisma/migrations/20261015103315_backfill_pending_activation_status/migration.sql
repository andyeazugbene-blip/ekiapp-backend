-- Data-only migration, no schema change.
--
-- Admin surfaced a real bug caused by the previous migration
-- (20261014184819_product_status_lifecycle)'s backfill gap: it only
-- reclassified isActive=true -> PUBLISHED and isActive=false WITH
-- adminUnpublishedAt -> REJECTED, leaving every OTHER isActive=false row
-- as the column default (DRAFT) regardless of whether the listing was
-- actually complete. Pre-session, an unverified vendor's COMPLETE
-- listing was force-drafted purely for lacking verification (the old
-- forceDraft = !vendor.isVerified || !isProductComplete(...) rule) —
-- those rows are semantically PENDING_ACTIVATION under the current
-- model, not DRAFT. Left uncorrected, admin saw the same product
-- simultaneously badged "Draft" (legacy 3-state view) AND "Awaiting
-- activation" (real status) for completely different rows, and genuine
-- pending-activation listings were miscounted as drafts.
--
-- Only touches rows that are STILL exactly where the original backfill
-- put them (status='DRAFT', isActive=false, adminUnpublishedAt NULL —
-- i.e. untouched since) and are both complete and owned by an
-- unverified vendor, matching exactly what computeProductStatus() would
-- assign today. A row any admin or vendor action has since changed no
-- longer matches this filter and is left alone.
UPDATE "Product" p
SET "status" = 'PENDING_ACTIVATION'
FROM "Vendor" v
WHERE p."vendorId" = v."id"
  AND p."status" = 'DRAFT'
  AND p."isActive" = false
  AND p."adminUnpublishedAt" IS NULL
  AND cardinality(p."images") > 0
  AND p."priceInCents" > 0
  AND v."verificationStatus" != 'VERIFIED';
