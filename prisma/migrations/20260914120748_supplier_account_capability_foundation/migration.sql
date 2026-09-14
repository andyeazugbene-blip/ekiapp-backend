-- CreateEnum
CREATE TYPE "SupplierAccountState" AS ENUM ('NOT_STARTED', 'DRAFT', 'VERIFICATION_REQUIRED', 'UNDER_REVIEW', 'INFORMATION_REQUIRED', 'APPROVED', 'PAUSED', 'RESTRICTED', 'SUSPENDED', 'CLOSED');

-- AlterTable
ALTER TABLE "PushToken" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "SupplierAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "legacySupplierProfileId" TEXT,
    "providerConnectedAccountId" TEXT,
    "supplierState" "SupplierAccountState" NOT NULL DEFAULT 'NOT_STARTED',
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "requirementsDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverageRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collectionAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "controlScope" TEXT,
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAccount_userId_key" ON "SupplierAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAccount_legacySupplierProfileId_key" ON "SupplierAccount"("legacySupplierProfileId");

-- CreateIndex
CREATE INDEX "SupplierAccount_supplierState_idx" ON "SupplierAccount"("supplierState");

-- AddForeignKey
ALTER TABLE "SupplierAccount" ADD CONSTRAINT "SupplierAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
