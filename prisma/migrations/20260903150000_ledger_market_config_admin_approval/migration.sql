-- CreateEnum
CREATE TYPE "MarketPaymentMode" AS ENUM ('DISABLED', 'TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "SupplierReleasePolicy" AS ENUM ('ON_DELIVERY_CONFIRMED', 'ON_FULFILMENT_MARKED', 'MANUAL_ADMIN_RELEASE');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('PROVIDER_CASH', 'PLATFORM_FEE_REVENUE', 'VENDOR_PAYABLE', 'SUPPLIER_PAYABLE', 'BUYER_WALLET_LIABILITY', 'REFUND_CLEARING', 'COMMUNITY_BUY_ESCROW');

-- CreateEnum
CREATE TYPE "LedgerOwnerType" AS ENUM ('PLATFORM', 'VENDOR', 'BUYER', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationDifferenceStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AdminApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "MarketConfiguration" ADD COLUMN     "acceptedIdentityDocuments" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "campaignMaxDurationHours" INTEGER,
ADD COLUMN     "campaignMaxValueAmount" INTEGER,
ADD COLUMN     "campaignMinDurationHours" INTEGER,
ADD COLUMN     "campaignMinValueAmount" INTEGER,
ADD COLUMN     "deliveryMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "identityProvider" TEXT,
ADD COLUMN     "legalTermsVersion" TEXT,
ADD COLUMN     "organiserFeeBps" INTEGER,
ADD COLUMN     "paymentMode" "MarketPaymentMode" NOT NULL DEFAULT 'DISABLED',
ADD COLUMN     "paymentProvider" TEXT,
ADD COLUMN     "refundTermsVersion" TEXT,
ADD COLUMN     "supplierReleasePolicy" "SupplierReleasePolicy" NOT NULL DEFAULT 'ON_DELIVERY_CONFIRMED';

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "currency" TEXT NOT NULL,
    "ownerType" "LedgerOwnerType" NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "businessRefType" TEXT NOT NULL,
    "businessRefId" TEXT NOT NULL,
    "providerRef" TEXT,
    "description" TEXT NOT NULL,
    "reversesEntryId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "totalChecked" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationDifference" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "businessRefType" TEXT NOT NULL,
    "businessRefId" TEXT NOT NULL,
    "providerRef" TEXT,
    "expectedAmount" INTEGER,
    "actualAmount" INTEGER,
    "kind" TEXT NOT NULL,
    "status" "ReconciliationDifferenceStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ReconciliationDifference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminApprovalRule" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "thresholdAmount" INTEGER,
    "currency" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminApprovalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminApproval" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "businessRefType" TEXT NOT NULL,
    "businessRefId" TEXT NOT NULL,
    "amount" INTEGER,
    "currency" TEXT,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AdminApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerAccount_ownerType_ownerId_idx" ON "LedgerAccount"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_type_currency_ownerType_ownerId_key" ON "LedgerAccount"("type", "currency", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_postedAt_idx" ON "LedgerEntry"("accountId", "postedAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_businessRefType_businessRefId_idx" ON "LedgerEntry"("businessRefType", "businessRefId");

-- CreateIndex
CREATE INDEX "LedgerEntry_providerRef_idx" ON "LedgerEntry"("providerRef");

-- CreateIndex
CREATE INDEX "ReconciliationRun_provider_startedAt_idx" ON "ReconciliationRun"("provider", "startedAt");

-- CreateIndex
CREATE INDEX "ReconciliationDifference_runId_status_idx" ON "ReconciliationDifference"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdminApprovalRule_actionType_key" ON "AdminApprovalRule"("actionType");

-- CreateIndex
CREATE INDEX "AdminApproval_status_actionType_idx" ON "AdminApproval"("status", "actionType");

-- CreateIndex
CREATE INDEX "AdminApproval_businessRefType_businessRefId_idx" ON "AdminApproval"("businessRefType", "businessRefId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationDifference" ADD CONSTRAINT "ReconciliationDifference_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminApproval" ADD CONSTRAINT "AdminApproval_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminApproval" ADD CONSTRAINT "AdminApproval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

