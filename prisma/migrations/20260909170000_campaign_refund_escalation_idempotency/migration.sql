ALTER TABLE "CampaignRefund" ADD COLUMN "escalated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CampaignRefund" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "CampaignRefund" ADD COLUMN "escalatedSupportCaseId" TEXT;
