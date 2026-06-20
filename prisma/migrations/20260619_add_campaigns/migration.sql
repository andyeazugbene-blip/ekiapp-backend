-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CampaignType" AS ENUM ('HOT_DEAL', 'GIFT_CARD');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CampaignType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "colorTheme" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "image" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "minimumCartAmountCents" INTEGER,
    "requiredProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "requiredCategoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "minimumOrders" INTEGER,
    "minimumSpendCents" INTEGER,
    "newCustomerOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_type_active_priority_idx" ON "Campaign"("type", "active", "priority");
