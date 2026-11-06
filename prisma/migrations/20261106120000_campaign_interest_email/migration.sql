-- Someone without an account can leave an email on a "coming soon" page.
ALTER TABLE "CampaignInterest" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "CampaignInterest" ADD COLUMN "email" TEXT;
ALTER TABLE "CampaignInterest" ADD COLUMN "notifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "CampaignInterest_campaignId_email_key" ON "CampaignInterest"("campaignId", "email");
