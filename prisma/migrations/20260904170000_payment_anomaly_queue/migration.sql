-- Admin duplicate-payment / financial-inconsistency queue (architecture
-- gap closure). Real findings only — no fabricated alerts.

-- CreateEnum
CREATE TYPE "PaymentAnomalyKind" AS ENUM ('DUPLICATE_PROVIDER_REF', 'MULTIPLE_SUCCESSFUL_ATTEMPTS', 'MISSING_LEDGER_ENTRY');

-- CreateEnum
CREATE TYPE "PaymentAnomalyStatus" AS ENUM ('OPEN', 'REVIEWED', 'ESCALATED');

-- CreateTable
CREATE TABLE "PaymentAnomaly" (
    "id" TEXT NOT NULL,
    "kind" "PaymentAnomalyKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "businessRefType" TEXT NOT NULL,
    "businessRefId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "PaymentAnomalyStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "note" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAnomaly_dedupeKey_key" ON "PaymentAnomaly"("dedupeKey");

-- CreateIndex
CREATE INDEX "PaymentAnomaly_status_createdAt_idx" ON "PaymentAnomaly"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAnomaly_kind_idx" ON "PaymentAnomaly"("kind");
