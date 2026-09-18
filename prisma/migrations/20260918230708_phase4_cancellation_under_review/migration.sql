-- CreateEnum
CREATE TYPE "CancellationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'CANCELLATION_UNDER_REVIEW';

-- CreateTable
CREATE TABLE "CampaignCancellationRequest" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "hadFinancialActivity" BOOLEAN NOT NULL,
    "preCancellationStatus" "CampaignStatus" NOT NULL,
    "status" "CancellationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCancellationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignCancellationRequest_campaignId_status_idx" ON "CampaignCancellationRequest"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "CampaignCancellationRequest" ADD CONSTRAINT "CampaignCancellationRequest_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
