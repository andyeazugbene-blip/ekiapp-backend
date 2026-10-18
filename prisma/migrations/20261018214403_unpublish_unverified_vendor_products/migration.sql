-- Data-only correction (18 Oct 2026): the vendor-activation gate added
-- 14 Oct 2026 only governs products created or edited AFTER it shipped.
-- Any product that was already isActive=true/PUBLISHED from BEFORE that
-- gate existed (when there was no verification requirement at all) was
-- left untouched by the earlier backfill migration, which only derived
-- `status` FROM the existing `isActive` value — it never re-checked
-- whether the owning vendor is actually verified. Confirmed live against
-- a real Postgres instance: such a product is still buyer-visible today
-- regardless of the vendor's current verification state.
--
-- This retroactively applies the same rule every write path already
-- enforces going forward: a product can only be PUBLISHED/isActive=true
-- if its vendor is VERIFIED. Demoted rows go to PENDING_ACTIVATION (not
-- REJECTED) — nothing is wrong with the listing itself, only the gate —
-- so vendorActivationService.publishEligibleProducts() automatically
-- re-publishes them the moment that vendor verifies, with no vendor
-- action needed, consistent with the rest of this spec.
UPDATE "Product" p
SET "status" = 'PENDING_ACTIVATION', "isActive" = false, "publishedAt" = NULL
FROM "Vendor" v
WHERE p."vendorId" = v."id"
  AND p."isActive" = true
  AND v."verificationStatus" != 'VERIFIED';
