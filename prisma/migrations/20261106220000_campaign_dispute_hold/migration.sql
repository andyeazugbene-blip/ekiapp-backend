ALTER TABLE "CommunityCampaign" ADD COLUMN "disputedAt" TIMESTAMP(3),
ADD COLUMN "disputedById" TEXT,
ADD COLUMN "disputeReason" TEXT;
