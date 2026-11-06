-- CB69: the supplier's inventory status for a campaign.
ALTER TABLE "CommunityCampaign" ADD COLUMN "supplierInventoryStatus" TEXT;
ALTER TABLE "CommunityCampaign" ADD COLUMN "supplierInventoryStatusAt" TIMESTAMP(3);
