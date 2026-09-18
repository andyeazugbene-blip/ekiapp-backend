/*
  Warnings:

  - Made the column `communityBuyFeeBps` on table `MarketConfiguration` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
ALTER TYPE "LedgerAccountType" ADD VALUE 'ORGANISER_PAYABLE';

-- AlterEnum
ALTER TYPE "LedgerOwnerType" ADD VALUE 'ORGANISER';

-- AlterTable
ALTER TABLE "CampaignContribution" ADD COLUMN     "buyerServiceFeeAmount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CampaignSupplierPayment" ADD COLUMN     "wholesaleAmount" INTEGER;

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "wholesaleAmountMinor" INTEGER;

-- Backfill: every existing MarketConfiguration row with no supplier-fee bps
-- configured yet gets the client-confirmed final V1 default (8%) instead of
-- being left null — the whole point of this migration is that these are no
-- longer "unresolved commercial decisions". A market this already applied a
-- different rate to (non-null) is left untouched.
UPDATE "MarketConfiguration" SET "communityBuyFeeBps" = 800 WHERE "communityBuyFeeBps" IS NULL;

-- AlterTable
ALTER TABLE "MarketConfiguration" ADD COLUMN     "buyerServiceFeeBps" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "buyerServiceFeeMaxAmount" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "buyerServiceFeeMinAmount" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "organiserCommissionBps" INTEGER NOT NULL DEFAULT 1000,
ALTER COLUMN "communityBuyFeeBps" SET NOT NULL,
ALTER COLUMN "communityBuyFeeBps" SET DEFAULT 800;

-- AlterTable
ALTER TABLE "OrganiserProfile" ADD COLUMN     "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "providerConnectedAccountId" TEXT;

-- CreateTable
CREATE TABLE "CommunityBuyOrganiserPayout" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "organiserId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'NOT_RELEASED',
    "payoutStripeAccountIdAtApproval" TEXT,
    "commissionAmount" INTEGER,
    "netAmount" INTEGER,
    "stripeTransferId" TEXT,
    "holdReason" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityBuyOrganiserPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityBuyOrganiserPayout_campaignId_key" ON "CommunityBuyOrganiserPayout"("campaignId");

-- CreateIndex
CREATE INDEX "CommunityBuyOrganiserPayout_status_idx" ON "CommunityBuyOrganiserPayout"("status");

-- CreateIndex
CREATE INDEX "CommunityBuyOrganiserPayout_organiserId_idx" ON "CommunityBuyOrganiserPayout"("organiserId");

-- AddForeignKey
ALTER TABLE "CommunityBuyOrganiserPayout" ADD CONSTRAINT "CommunityBuyOrganiserPayout_organiserId_fkey" FOREIGN KEY ("organiserId") REFERENCES "OrganiserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityBuyOrganiserPayout" ADD CONSTRAINT "CommunityBuyOrganiserPayout_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
