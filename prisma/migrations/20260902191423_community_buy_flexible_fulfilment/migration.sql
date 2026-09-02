-- CreateEnum
CREATE TYPE "FundingOutcome" AS ENUM ('PENDING', 'GOAL_REACHED', 'MINIMUM_REACHED', 'BELOW_MINIMUM');

-- CreateEnum
CREATE TYPE "ExtensionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SupplierPaymentStatus" AS ENUM ('NOT_RELEASED', 'PROCESSING', 'PAID', 'ON_HOLD', 'FAILED');

-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'RESCUE_WINDOW';

-- AlterTable
ALTER TABLE "CampaignContribution" ADD COLUMN     "isOrganiserTopUp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "confirmedShares" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extensionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fundingOutcome" "FundingOutcome" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "goalShares" INTEGER,
ADD COLUMN     "maximumShares" INTEGER,
ADD COLUMN     "minimumShares" INTEGER,
ADD COLUMN     "pricePerShareMinor" INTEGER,
ADD COLUMN     "rescueDurationMinutes" INTEGER NOT NULL DEFAULT 2880,
ADD COLUMN     "rescueEndsAt" TIMESTAMP(3),
ADD COLUMN     "supplierCommitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supplierCommittedAt" TIMESTAMP(3),
ADD COLUMN     "termsLockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignExtensionRequest" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "requestedDeadline" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "supplierReconfirmed" BOOLEAN NOT NULL DEFAULT false,
    "priceUnchangedConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "participantTermsUnchanged" BOOLEAN NOT NULL DEFAULT false,
    "status" "ExtensionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignExtensionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSupplierPayment" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'NOT_RELEASED',
    "payoutStripeAccountIdAtApproval" TEXT,
    "holdReason" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignExtensionRequest_campaignId_status_idx" ON "CampaignExtensionRequest"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSupplierPayment_campaignId_key" ON "CampaignSupplierPayment"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignSupplierPayment_status_idx" ON "CampaignSupplierPayment"("status");

-- CreateIndex
CREATE INDEX "CommunityCampaign_rescueEndsAt_idx" ON "CommunityCampaign"("rescueEndsAt");

-- AddForeignKey
ALTER TABLE "CampaignExtensionRequest" ADD CONSTRAINT "CampaignExtensionRequest_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSupplierPayment" ADD CONSTRAINT "CampaignSupplierPayment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
