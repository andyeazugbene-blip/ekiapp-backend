-- Store-scope promo codes so coupon codes cannot apply globally across vendors.
ALTER TABLE "PromoCode" ADD COLUMN "vendorId" TEXT;

UPDATE "PromoCode" AS promo
SET "vendorId" = audit."actorId"
FROM "AuditLog" AS audit
WHERE audit."entityType" = 'PROMO_CODE'
  AND audit."action" = 'vendor.promo.created'
  AND audit."entityId" = promo."id"
  AND promo."vendorId" IS NULL;

DO $$
DECLARE
  fallback_vendor_id TEXT;
BEGIN
  SELECT "id" INTO fallback_vendor_id FROM "Vendor" ORDER BY "createdAt" ASC LIMIT 1;

  IF EXISTS (SELECT 1 FROM "PromoCode" WHERE "vendorId" IS NULL) AND fallback_vendor_id IS NULL THEN
    RAISE EXCEPTION 'Cannot backfill PromoCode.vendorId because no vendors exist';
  END IF;

  UPDATE "PromoCode"
  SET "vendorId" = fallback_vendor_id
  WHERE "vendorId" IS NULL;
END $$;

ALTER TABLE "PromoCode" ALTER COLUMN "vendorId" SET NOT NULL;
DROP INDEX IF EXISTS "PromoCode_code_key";
CREATE UNIQUE INDEX "PromoCode_vendorId_code_key" ON "PromoCode"("vendorId", "code");
CREATE INDEX "PromoCode_vendorId_isActive_idx" ON "PromoCode"("vendorId", "isActive");
ALTER TABLE "PromoCode"
  ADD CONSTRAINT "PromoCode_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
