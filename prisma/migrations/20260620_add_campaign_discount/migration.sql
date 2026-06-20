-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CampaignDiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "discountType" "CampaignDiscountType";
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "discountValue" INTEGER;
