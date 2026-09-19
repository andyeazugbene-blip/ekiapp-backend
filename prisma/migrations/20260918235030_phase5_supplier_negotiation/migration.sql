-- CreateEnum
CREATE TYPE "SupplierProposalStatus" AS ENUM ('SUBMITTED', 'ADMIN_CHANGES_NEEDED', 'AWAITING_ORGANISER', 'ORGANISER_ACCEPTED', 'ORGANISER_REJECTED', 'WITHDRAWN', 'EXPIRED');

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "agreedReadyByDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignSupplierProposal" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierAccountId" TEXT,
    "submittedByUserId" TEXT NOT NULL,
    "proposedWholesaleAmountMinor" INTEGER,
    "proposedMaximumShares" INTEGER,
    "proposedReadyByDate" TIMESTAMP(3),
    "message" TEXT NOT NULL,
    "status" "SupplierProposalStatus" NOT NULL DEFAULT 'SUBMITTED',
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "adminReviewedById" TEXT,
    "adminReviewedAt" TIMESTAMP(3),
    "adminNotes" TEXT,
    "organiserRespondedById" TEXT,
    "organiserRespondedAt" TIMESTAMP(3),
    "organiserNotes" TEXT,
    "respondByDeadline" TIMESTAMP(3) NOT NULL,
    "remindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSupplierProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignSupplierProposal_campaignId_status_idx" ON "CampaignSupplierProposal"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "CampaignSupplierProposal" ADD CONSTRAINT "CampaignSupplierProposal_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
