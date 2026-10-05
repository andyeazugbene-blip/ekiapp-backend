-- Handbook 10 / 14.9 / 14.11 - Community Buy operations, market payment readiness, supplier decisions.

-- AlterEnum
ALTER TYPE "SupplierAccountState" ADD VALUE IF NOT EXISTS 'REJECTED';

-- AlterTable: SupplierAccount
ALTER TABLE "SupplierAccount"
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- AlterTable: CommunityCampaign
ALTER TABLE "CommunityCampaign"
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "paymentDeadline" TIMESTAMP(3),
  ADD COLUMN "fulfilmentDeadline" TIMESTAMP(3),
  ADD COLUMN "reviewCriteria" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "CommunityCampaign_slug_key" ON "CommunityCampaign"("slug");

-- AlterTable: MarketConfiguration (verified payment readiness)
ALTER TABLE "MarketConfiguration"
  ADD COLUMN "providerSupported" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "providerConfigChecked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legalApprovalRef" TEXT,
  ADD COLUMN "refundTested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "testTransactionAt" TIMESTAMP(3),
  ADD COLUMN "readinessApprovedById" TEXT,
  ADD COLUMN "readinessApprovedAt" TIMESTAMP(3),
  ADD COLUMN "enablementReason" TEXT,
  ADD COLUMN "readinessUnverified" BOOLEAN NOT NULL DEFAULT false;

-- Safe backfill (do NOT break production): a market that already has Community Buy
-- payments enabled stays enabled, but is flagged "readiness unverified" so the admin
-- UI shows a warning until a Super Administrator records real readiness evidence.
-- Markets that are not enabled are untouched (and can no longer be enabled without evidence).
UPDATE "MarketConfiguration"
SET "readinessUnverified" = true
WHERE "communityBuyPaymentsEnabled" = true;
