-- AlterEnum
ALTER TYPE "DataAccessCategory" ADD VALUE 'ADDRESS_DETAIL';

-- AlterTable
ALTER TABLE "CampaignContribution" ADD COLUMN     "deliveryAddressLine1" TEXT,
ADD COLUMN     "deliveryAddressLine2" TEXT,
ADD COLUMN     "deliveryCity" TEXT,
ADD COLUMN     "deliveryPostcode" TEXT,
ADD COLUMN     "deliveryRecipientName" TEXT;

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "collectionAddressLine1" TEXT,
ADD COLUMN     "collectionAddressLine2" TEXT,
ADD COLUMN     "collectionCity" TEXT,
ADD COLUMN     "collectionPostcode" TEXT,
ADD COLUMN     "deliveryCoverageAreas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
