-- Client mandate (2026-09): "Eki never takes the fund upfront... payment go
-- to the owner [only] at end of campaign, Eki takes its processing fee."
-- Replaces the pay-now/refund-on-failure contribution flow with
-- PLEDGE_THEN_CHARGE: a payment method is saved (SetupIntent, no capture)
-- at pledge time, and the actual off-session charge only happens once the
-- campaign succeeds. See campaign-contributions.service.ts.

-- AlterEnum
ALTER TYPE "ContributionStatus" ADD VALUE 'PLEDGED';
ALTER TYPE "ContributionStatus" ADD VALUE 'CHARGE_FAILED';

-- AlterTable
ALTER TABLE "CampaignContribution" ADD COLUMN     "paymentMethodId" TEXT;

-- AlterTable
ALTER TABLE "CampaignSupplierPayment" ADD COLUMN     "feeAmount" INTEGER,
ADD COLUMN     "netAmount" INTEGER,
ADD COLUMN     "stripeTransferId" TEXT;

-- AlterTable
ALTER TABLE "MarketConfiguration" ADD COLUMN     "communityBuyFeeBps" INTEGER;

-- CreateTable
CREATE TABLE "CampaignChargeAttempt" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "SubscriptionPaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignChargeAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignChargeAttempt_idempotencyKey_key" ON "CampaignChargeAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CampaignChargeAttempt_contributionId_idx" ON "CampaignChargeAttempt"("contributionId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignChargeAttempt_contributionId_attemptNumber_key" ON "CampaignChargeAttempt"("contributionId", "attemptNumber");

-- CreateIndex
CREATE INDEX "CampaignContribution_paymentMethodId_idx" ON "CampaignContribution"("paymentMethodId");

-- AddForeignKey
ALTER TABLE "CampaignContribution" ADD CONSTRAINT "CampaignContribution_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "BuyerPaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignChargeAttempt" ADD CONSTRAINT "CampaignChargeAttempt_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "CampaignContribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
