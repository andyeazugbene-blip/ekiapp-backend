-- CreateEnum
CREATE TYPE "DisputeType" AS ENUM ('NOT_RECEIVED', 'DAMAGED', 'WRONG_ITEM', 'QUALITY', 'OTHER');
CREATE TYPE "DisputeAppealStatus" AS ENUM ('NONE', 'REQUESTED', 'UPHELD', 'OVERTURNED');
CREATE TYPE "DisputeParty" AS ENUM ('BUYER', 'VENDOR', 'ADMIN');
CREATE TYPE "DisputeEvidenceKind" AS ENUM ('PHOTO', 'DOCUMENT', 'TEXT');
CREATE TYPE "OrderEvidenceKind" AS ENUM ('DELIVERY_PHOTO', 'PICKUP_CONFIRMATION', 'SIGNATURE', 'NOTE');
CREATE TYPE "OrderEvidenceRole" AS ENUM ('VENDOR', 'COURIER', 'ADMIN');

-- AlterTable
ALTER TABLE "Dispute"
  ADD COLUMN "type" "DisputeType" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "claim" TEXT,
  ADD COLUMN "respondByAt" TIMESTAMP(3),
  ADD COLUMN "appealStatus" "DisputeAppealStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "appealReason" TEXT,
  ADD COLUMN "appealRequestedById" TEXT,
  ADD COLUMN "appealRequestedAt" TIMESTAMP(3),
  ADD COLUMN "appealDecidedById" TEXT,
  ADD COLUMN "appealDecidedAt" TIMESTAMP(3),
  ADD COLUMN "appealDecisionReason" TEXT,
  ADD COLUMN "decisionReason" TEXT,
  ADD COLUMN "evidenceRequestedAt" TIMESTAMP(3),
  ADD COLUMN "evidenceRequestedFrom" TEXT;

-- Existing open disputes get a response deadline of 5 days from creation.
UPDATE "Dispute" SET "respondByAt" = "createdAt" + INTERVAL '5 days' WHERE "respondByAt" IS NULL;

-- CreateTable
CREATE TABLE "DisputeEvidence" (
  "id" TEXT NOT NULL,
  "disputeId" TEXT NOT NULL,
  "submittedById" TEXT NOT NULL,
  "submitterRole" "DisputeParty" NOT NULL,
  "kind" "DisputeEvidenceKind" NOT NULL,
  "uploadAssetId" TEXT,
  "text" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DisputeEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DisputeMessage" (
  "id" TEXT NOT NULL,
  "disputeId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "authorRole" "DisputeParty" NOT NULL,
  "body" TEXT NOT NULL,
  "internal" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DisputeMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderEvidence" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "kind" "OrderEvidenceKind" NOT NULL,
  "uploadAssetId" TEXT,
  "note" TEXT,
  "submittedById" TEXT NOT NULL,
  "submitterRole" "OrderEvidenceRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderEvidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DisputeEvidence_disputeId_createdAt_idx" ON "DisputeEvidence"("disputeId", "createdAt");
CREATE INDEX "DisputeMessage_disputeId_createdAt_idx" ON "DisputeMessage"("disputeId", "createdAt");
CREATE INDEX "OrderEvidence_orderId_createdAt_idx" ON "OrderEvidence"("orderId", "createdAt");

ALTER TABLE "DisputeEvidence" ADD CONSTRAINT "DisputeEvidence_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DisputeMessage" ADD CONSTRAINT "DisputeMessage_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderEvidence" ADD CONSTRAINT "OrderEvidence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
