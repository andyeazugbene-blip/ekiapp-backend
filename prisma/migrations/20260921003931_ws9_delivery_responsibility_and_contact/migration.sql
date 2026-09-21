-- CreateEnum
CREATE TYPE "CampaignDeliveryResponsibility" AS ENUM ('ORGANISER', 'SUPPLIER', 'SHARED');

-- AlterTable
ALTER TABLE "CampaignContribution" ADD COLUMN     "deliveryInstructions" TEXT,
ADD COLUMN     "deliveryPhone" TEXT;

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "deliveryResponsibility" "CampaignDeliveryResponsibility" NOT NULL DEFAULT 'ORGANISER';
