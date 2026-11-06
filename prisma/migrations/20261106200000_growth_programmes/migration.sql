-- Handbook 8.3 First Sale Campaign and 8.6 vendor referral credits.
CREATE TYPE "VendorReferralCreditStatus" AS ENUM ('QUALIFIED', 'RELEASED', 'REVERSED');
CREATE TABLE "VendorReferralCredit" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "referredVendorId" TEXT NOT NULL,
    "status" "VendorReferralCreditStatus" NOT NULL,
    "qualifiedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "stripeBalanceTransactionId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VendorReferralCredit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorReferralCredit_referredUserId_key" ON "VendorReferralCredit"("referredUserId");
CREATE INDEX "VendorReferralCredit_referrerId_status_idx" ON "VendorReferralCredit"("referrerId", "status");

CREATE TYPE "FirstSaleCampaignStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'STOPPED');
CREATE TABLE "FirstSaleCampaign" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "FirstSaleCampaignStatus" NOT NULL,
    "launchProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "stoppedById" TEXT,
    "buyersMessaged" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FirstSaleCampaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FirstSaleCampaign_vendorId_key" ON "FirstSaleCampaign"("vendorId");
CREATE INDEX "FirstSaleCampaign_status_idx" ON "FirstSaleCampaign"("status");
ALTER TABLE "FirstSaleCampaign" ADD CONSTRAINT "FirstSaleCampaign_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
