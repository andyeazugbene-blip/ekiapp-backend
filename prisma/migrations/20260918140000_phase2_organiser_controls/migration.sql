-- AlterEnum
ALTER TYPE "SupportCaseType" ADD VALUE 'CAMPAIGN_CHANGE_REQUEST';

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "adminIssueNotes" TEXT,
ADD COLUMN     "perBuyerMaxShares" INTEGER,
ADD COLUMN     "perBuyerMinShares" INTEGER,
ADD COLUMN     "scheduledOpenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrganiserProfile" ADD COLUMN     "firstNameOnlyDisplay" BOOLEAN NOT NULL DEFAULT true;
