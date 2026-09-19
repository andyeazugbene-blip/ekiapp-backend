-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "deliveryFeeAmountMinor" INTEGER;

-- AlterTable
ALTER TABLE "CampaignContribution" ADD COLUMN     "deliveryFeeAmountMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DeliveryReference" ADD COLUMN     "collectionCode" TEXT,
ADD COLUMN     "collectionCodeRedeemedAt" TIMESTAMP(3),
ADD COLUMN     "collectionCodeRedeemedByUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReference_campaignId_collectionCode_key" ON "DeliveryReference"("campaignId", "collectionCode");
