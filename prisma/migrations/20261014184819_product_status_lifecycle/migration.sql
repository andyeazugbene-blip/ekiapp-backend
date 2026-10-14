-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PENDING_ACTIVATION', 'PUBLISHED', 'PAUSED', 'REJECTED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT';

-- CreateIndex
CREATE INDEX "Product_vendorId_status_idx" ON "Product"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");

-- Backfill: every row defaulted to 'DRAFT' above. Without this, every
-- already-published listing would show status=DRAFT (isActive stays true
-- and buyer visibility is unaffected, but the new status field — which
-- admin/vendor UI and auto-publish now read — would be wrong for all
-- pre-existing data).
UPDATE "Product" SET "status" = 'PUBLISHED', "publishedAt" = "createdAt" WHERE "isActive" = true;
UPDATE "Product" SET "status" = 'REJECTED' WHERE "isActive" = false AND "adminUnpublishedAt" IS NOT NULL;
-- Remaining isActive=false rows with no adminUnpublishedAt keep the
-- column default of 'DRAFT' — correct: they were never published and
-- nobody paused/rejected them, matching the pre-migration DRAFT bucket
-- admin-products.service.ts already derived the same way.
