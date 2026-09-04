-- Admin supplier-fulfilment delay queue (architecture gap closure). Real
-- findings from actual CampaignFulfilment rows — no fabricated alerts.

-- CreateEnum
CREATE TYPE "FulfilmentAlertReason" AS ENUM ('PAST_ESTIMATED_READY_DATE', 'STALE_NO_PROGRESS');

-- CreateEnum
CREATE TYPE "FulfilmentAlertStatus" AS ENUM ('OPEN', 'CONTACTED', 'RESOLVED', 'ESCALATED');

-- CreateTable
CREATE TABLE "SupplierFulfilmentAlert" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "reason" "FulfilmentAlertReason" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "FulfilmentAlertStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "contactedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierFulfilmentAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierFulfilmentAlert_dedupeKey_key" ON "SupplierFulfilmentAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "SupplierFulfilmentAlert_status_createdAt_idx" ON "SupplierFulfilmentAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SupplierFulfilmentAlert_campaignId_idx" ON "SupplierFulfilmentAlert"("campaignId");

-- AddForeignKey
ALTER TABLE "SupplierFulfilmentAlert" ADD CONSTRAINT "SupplierFulfilmentAlert_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
