-- Phase 1: supplier offers, one review queue, capabilities. Additive only:
-- every new column is nullable or has a default, and no existing row changes.

-- CreateEnum
CREATE TYPE "SupplierOfferStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'INFO_REQUIRED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUSPENDED', 'SUPERSEDED');
CREATE TYPE "ReviewRequestType" AS ENUM ('SUPPLIER_ELIGIBILITY', 'SUPPLIER_OFFER', 'COMMUNITY_BUY_CAMPAIGN', 'EXTENSION');
CREATE TYPE "ReviewRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUSPENDED');
CREATE TYPE "CapabilityType" AS ENUM ('BUYER', 'ORGANISER', 'VENDOR', 'SUPPLIER');
CREATE TYPE "CapabilityStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3), ADD COLUMN "partnerCode" TEXT;
ALTER TABLE "SupplierAccount" ADD COLUMN "leadTimeDays" INTEGER, ADD COLUMN "storageNotes" TEXT;
ALTER TABLE "CommunityCampaign" ADD COLUMN "supplierOfferId" TEXT;
ALTER TABLE "MarketConfiguration" ADD COLUMN "communityBuyOffersRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SupplierOffer" (
    "id" TEXT NOT NULL,
    "supplierAccountId" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'GB',
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousVersionId" TEXT,
    "foodstuffName" TEXT NOT NULL,
    "description" TEXT,
    "packSize" TEXT NOT NULL,
    "weightGrams" INTEGER,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currency" TEXT NOT NULL,
    "pricePerShareMinor" INTEGER NOT NULL,
    "minimumShares" INTEGER NOT NULL,
    "maximumShares" INTEGER NOT NULL,
    "windowStartsAt" TIMESTAMP(3) NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "fulfilmentMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliveryAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliveryFeeMinor" INTEGER,
    "collectionAddressLine1" TEXT,
    "collectionCity" TEXT,
    "collectionPostcode" TEXT,
    "leadTimeDays" INTEGER,
    "status" "SupplierOfferStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierOffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewRequest" (
    "id" TEXT NOT NULL,
    "type" "ReviewRequestType" NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'GB',
    "status" "ReviewRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "reviewerId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "infoMessage" TEXT,
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CapabilityGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capability" "CapabilityType" NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'GB',
    "status" "CapabilityStatus" NOT NULL DEFAULT 'PENDING',
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CapabilityGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT,
    "supplierAccountId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DemandRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "foodstuff" TEXT NOT NULL,
    "area" TEXT,
    "market" TEXT NOT NULL DEFAULT 'GB',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DemandRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CampaignInterest" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOffer_previousVersionId_key" ON "SupplierOffer"("previousVersionId");
CREATE INDEX "SupplierOffer_status_market_idx" ON "SupplierOffer"("status", "market");
CREATE INDEX "SupplierOffer_supplierAccountId_idx" ON "SupplierOffer"("supplierAccountId");
CREATE INDEX "ReviewRequest_status_slaDueAt_idx" ON "ReviewRequest"("status", "slaDueAt");
CREATE INDEX "ReviewRequest_type_status_idx" ON "ReviewRequest"("type", "status");
CREATE INDEX "ReviewRequest_subjectType_subjectId_idx" ON "ReviewRequest"("subjectType", "subjectId");
CREATE UNIQUE INDEX "CapabilityGrant_userId_capability_market_key" ON "CapabilityGrant"("userId", "capability", "market");
CREATE INDEX "CapabilityGrant_capability_status_idx" ON "CapabilityGrant"("capability", "status");
CREATE UNIQUE INDEX "BusinessMember_userId_vendorId_key" ON "BusinessMember"("userId", "vendorId");
CREATE UNIQUE INDEX "BusinessMember_userId_supplierAccountId_key" ON "BusinessMember"("userId", "supplierAccountId");
CREATE INDEX "DemandRequest_foodstuff_idx" ON "DemandRequest"("foodstuff");
CREATE INDEX "DemandRequest_createdAt_idx" ON "DemandRequest"("createdAt");
CREATE UNIQUE INDEX "CampaignInterest_campaignId_userId_key" ON "CampaignInterest"("campaignId", "userId");

-- A double tap on Submit must create exactly one open request (Phase 1 acceptance test).
-- Prisma can't express a partial unique index, so it lives here; the service treats a clash as "already submitted".
CREATE UNIQUE INDEX "ReviewRequest_one_open_per_subject" ON "ReviewRequest"("type", "subjectType", "subjectId")
  WHERE "status" IN ('SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED');

-- AddForeignKey
ALTER TABLE "CommunityCampaign" ADD CONSTRAINT "CommunityCampaign_supplierOfferId_fkey" FOREIGN KEY ("supplierOfferId") REFERENCES "SupplierOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierOffer" ADD CONSTRAINT "SupplierOffer_supplierAccountId_fkey" FOREIGN KEY ("supplierAccountId") REFERENCES "SupplierAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DemandRequest" ADD CONSTRAINT "DemandRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignInterest" ADD CONSTRAINT "CampaignInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "PhoneVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PhoneVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PhoneVerification_userId_key" ON "PhoneVerification"("userId");
ALTER TABLE "PhoneVerification" ADD CONSTRAINT "PhoneVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
