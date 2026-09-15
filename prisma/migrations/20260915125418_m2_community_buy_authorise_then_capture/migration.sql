-- CreateEnum
CREATE TYPE "CommunityBuyHoldStatus" AS ENUM ('NOT_REQUESTED', 'HOLD_PENDING', 'REQUIRES_ACTION', 'HOLD_SUCCEEDED', 'HOLD_DECLINED', 'HOLD_EXPIRING', 'HOLD_RELEASED');

-- CreateEnum
CREATE TYPE "CommunityBuyCaptureStatus" AS ENUM ('NOT_CAPTURED', 'CAPTURE_PENDING', 'CAPTURED', 'CAPTURE_FAILED', 'REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "CommunityBuyPayoutStatus" AS ENUM ('HELD', 'READY', 'PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'REVERSED', 'CANCELLED', 'MANUAL_REVIEW');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignStatus" ADD VALUE 'HOLD_WINDOW';
ALTER TYPE "CampaignStatus" ADD VALUE 'DECISION_REQUIRED';
ALTER TYPE "CampaignStatus" ADD VALUE 'AWAITING_SUPPLIER_RECONFIRMATION';
ALTER TYPE "CampaignStatus" ADD VALUE 'PAYMENT_CAPTURE';

-- AlterEnum
ALTER TYPE "LedgerAccountType" ADD VALUE 'SUPPLIER_CONNECTED_BALANCE';

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "decisionDeadline" TIMESTAMP(3),
ADD COLUMN     "decisionRequiredAt" TIMESTAMP(3),
ADD COLUMN     "holdWindowStartsAt" TIMESTAMP(3),
ADD COLUMN     "paymentMode" "CommunityBuyPaymentMode" NOT NULL DEFAULT 'PLEDGE_THEN_CHARGE',
ADD COLUMN     "reconfirmationDeadline" TIMESTAMP(3),
ADD COLUMN     "reconfirmationQuantity" INTEGER,
ADD COLUMN     "reconfirmationRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CommunityBuyPaymentAuthorisation" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "supplierConnectedAccountId" TEXT NOT NULL,
    "setupIntentId" TEXT NOT NULL,
    "paymentMethodReference" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "consentWordingVersion" TEXT NOT NULL,
    "consentedChargeAmount" INTEGER NOT NULL,
    "consentCurrency" TEXT NOT NULL,
    "authorisedAmount" INTEGER,
    "holdStatus" "CommunityBuyHoldStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "holdCreatedAt" TIMESTAMP(3),
    "captureBefore" TIMESTAMP(3),
    "holdExpiryWarningAt" TIMESTAMP(3),
    "holdRecoveryDeadline" TIMESTAMP(3),
    "authenticationStatus" TEXT,
    "captureStatus" "CommunityBuyCaptureStatus" NOT NULL DEFAULT 'NOT_CAPTURED',
    "providerErrorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "latestWebhookEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityBuyPaymentAuthorisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityBuyPayout" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierConnectedAccountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "capturedGrossAmount" INTEGER NOT NULL DEFAULT 0,
    "providerFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "supplierPayableAmount" INTEGER NOT NULL DEFAULT 0,
    "organiserFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "ekiFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "refundDeductionAmount" INTEGER NOT NULL DEFAULT 0,
    "disputeDeductionAmount" INTEGER NOT NULL DEFAULT 0,
    "reserveAmount" INTEGER NOT NULL DEFAULT 0,
    "netPayoutAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "CommunityBuyPayoutStatus" NOT NULL DEFAULT 'HELD',
    "holdReasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "releaseCondition" TEXT,
    "releaseEligibleAt" TIMESTAMP(3),
    "providerPayoutId" TEXT,
    "providerBalanceTransactionId" TEXT,
    "requestedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "inTransitAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "latestProviderEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityBuyPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyPaymentAuthorisation_contributionId_key" ON "CommunityBuyPaymentAuthorisation"("contributionId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyPaymentAuthorisation_paymentIntentId_key" ON "CommunityBuyPaymentAuthorisation"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyPaymentAuthorisation_idempotencyKey_key" ON "CommunityBuyPaymentAuthorisation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CommunityBuyPaymentAuthorisation_campaignId_idx" ON "CommunityBuyPaymentAuthorisation"("campaignId");

-- CreateIndex
CREATE INDEX "CommunityBuyPaymentAuthorisation_holdStatus_idx" ON "CommunityBuyPaymentAuthorisation"("holdStatus");

-- CreateIndex
CREATE INDEX "CommunityBuyPaymentAuthorisation_captureBefore_idx" ON "CommunityBuyPaymentAuthorisation"("captureBefore");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyPayout_campaignId_key" ON "CommunityBuyPayout"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyPayout_idempotencyKey_key" ON "CommunityBuyPayout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CommunityBuyPayout_status_idx" ON "CommunityBuyPayout"("status");

-- CreateIndex
CREATE INDEX "CommunityCampaign_paymentMode_status_idx" ON "CommunityCampaign"("paymentMode", "status");

-- AddForeignKey
ALTER TABLE "CommunityBuyPaymentAuthorisation" ADD CONSTRAINT "CommunityBuyPaymentAuthorisation_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "CampaignContribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityBuyPaymentAuthorisation" ADD CONSTRAINT "CommunityBuyPaymentAuthorisation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityBuyPayout" ADD CONSTRAINT "CommunityBuyPayout_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
