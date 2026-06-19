-- AlterTable
ALTER TABLE "SellerPlan" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "SellerPlan_isDefault_idx" ON "SellerPlan"("isDefault");

-- Backfill: mark existing "starter" slug as default so behavior is unchanged until admin picks a new default.
UPDATE "SellerPlan" SET "isDefault" = true WHERE "slug" = 'starter' AND "deletedAt" IS NULL;
