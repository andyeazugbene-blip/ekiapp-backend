-- CreateEnum
CREATE TYPE "CampaignDeliveryPreference" AS ENUM ('COLLECTION', 'DELIVERY');

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "deliveryPreference" "CampaignDeliveryPreference" NOT NULL DEFAULT 'COLLECTION',
ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "qualityNotes" TEXT,
ADD COLUMN     "quantityPerOrder" INTEGER,
ADD COLUMN     "unit" TEXT,
ALTER COLUMN "country" DROP NOT NULL,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "deadline" DROP NOT NULL;
