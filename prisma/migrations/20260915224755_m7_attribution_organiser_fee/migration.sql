-- CreateEnum
CREATE TYPE "AttributionSource" AS ENUM ('DIRECT_JOIN', 'REORDER_RETAINED', 'SELF');

-- CreateEnum
CREATE TYPE "AttributionStatus" AS ENUM ('ACTIVE', 'UNDER_REVIEW', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "CommunityBuyOrganiserFeeStatus" AS ENUM ('ACCRUED', 'HELD', 'BLOCKED_NO_SETTLEMENT_ROUTE', 'SETTLED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "OrganiserFeeSettlementMethod" AS ENUM ('NONE', 'EXTERNAL_SUPPLIER_ARRANGEMENT', 'NON_CASH_REWARD', 'STRIPE_CONNECT_TRANSFER');

-- AlterTable
ALTER TABLE "CampaignParticipant" ADD COLUMN     "acquiredAt" TIMESTAMP(3),
ADD COLUMN     "acquisitionCampaignId" TEXT,
ADD COLUMN     "acquisitionOrganiserId" TEXT,
ADD COLUMN     "attributionOverrideReason" TEXT,
ADD COLUMN     "attributionSource" "AttributionSource",
ADD COLUMN     "attributionStatus" "AttributionStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "organiserAttributionExpiresAt" TIMESTAMP(3),
ADD COLUMN     "repeatCampaignParentId" TEXT;

-- CreateTable
CREATE TABLE "CommunityBuyOrganiserFee" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "organiserId" TEXT NOT NULL,
    "supplierId" TEXT,
    "currency" TEXT NOT NULL,
    "feePerCapturedOrder" INTEGER NOT NULL,
    "capturedQuantity" INTEGER NOT NULL DEFAULT 0,
    "grossFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "refundDeductionAmount" INTEGER NOT NULL DEFAULT 0,
    "disputeDeductionAmount" INTEGER NOT NULL DEFAULT 0,
    "netFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "CommunityBuyOrganiserFeeStatus" NOT NULL DEFAULT 'ACCRUED',
    "settlementMethod" "OrganiserFeeSettlementMethod" NOT NULL DEFAULT 'NONE',
    "providerReference" TEXT,
    "releaseCondition" TEXT,
    "heldReasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settledAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityBuyOrganiserFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganiserFeeAccrualEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganiserFeeAccrualEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyOrganiserFee_campaignId_key" ON "CommunityBuyOrganiserFee"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyOrganiserFee_idempotencyKey_key" ON "CommunityBuyOrganiserFee"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CommunityBuyOrganiserFee_status_idx" ON "CommunityBuyOrganiserFee"("status");

-- CreateIndex
CREATE INDEX "CommunityBuyOrganiserFee_organiserId_idx" ON "CommunityBuyOrganiserFee"("organiserId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganiserFeeAccrualEvent_contributionId_key" ON "OrganiserFeeAccrualEvent"("contributionId");

-- CreateIndex
CREATE INDEX "OrganiserFeeAccrualEvent_campaignId_idx" ON "OrganiserFeeAccrualEvent"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignParticipant_acquisitionOrganiserId_idx" ON "CampaignParticipant"("acquisitionOrganiserId");

-- AddForeignKey
ALTER TABLE "CommunityBuyOrganiserFee" ADD CONSTRAINT "CommunityBuyOrganiserFee_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
