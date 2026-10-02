-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "UploadModerationStatus" AS ENUM ('NOT_REVIEWED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REMOVED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedById" TEXT,
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalatedById" TEXT,
ADD COLUMN     "escalationNote" TEXT,
ADD COLUMN     "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "isInternal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureMessage" TEXT,
ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentMethodType" TEXT,
ADD COLUMN     "providerStatus" TEXT;

-- AlterTable
ALTER TABLE "UploadAsset" ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "moderationStatus" "UploadModerationStatus" NOT NULL DEFAULT 'NOT_REVIEWED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "anonymisedAt" TIMESTAMP(3),
ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspendedUntil" TIMESTAMP(3),
ADD COLUMN     "suspensionEvidence" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeDisabledReason" TEXT,
ADD COLUMN     "stripeRequirementsCurrentlyDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stripeRequirementsDeadline" TIMESTAMP(3),
ADD COLUMN     "stripeRequirementsEventuallyDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stripeRequirementsPastDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stripeStatusFetchedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspendedUntil" TIMESTAMP(3),
ADD COLUMN     "suspensionEvidence" TEXT;

-- CreateTable
CREATE TABLE "ContentDecision" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "UploadModerationStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "reportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminNote" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentDecision_assetId_createdAt_idx" ON "ContentDecision"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminNote_entityType_entityId_createdAt_idx" ON "AdminNote"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "UploadAsset_moderationStatus_createdAt_idx" ON "UploadAsset"("moderationStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "ContentDecision" ADD CONSTRAINT "ContentDecision_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "UploadAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
