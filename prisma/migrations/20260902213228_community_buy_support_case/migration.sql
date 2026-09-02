-- CreateEnum
CREATE TYPE "SupportCaseType" AS ENUM ('PAYMENT_ISSUE', 'REFUND_ISSUE', 'FULFILMENT_ISSUE', 'ORGANISER_CONDUCT', 'SUPPLIER_CONDUCT', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "CommunityBuySupportCase" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "caseType" "SupportCaseType" NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "internalNotes" TEXT,
    "customerVisibleResponse" TEXT,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "escalatedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityBuySupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunityBuySupportCase_campaignId_idx" ON "CommunityBuySupportCase"("campaignId");

-- CreateIndex
CREATE INDEX "CommunityBuySupportCase_participantId_idx" ON "CommunityBuySupportCase"("participantId");

-- CreateIndex
CREATE INDEX "CommunityBuySupportCase_status_idx" ON "CommunityBuySupportCase"("status");

-- AddForeignKey
ALTER TABLE "CommunityBuySupportCase" ADD CONSTRAINT "CommunityBuySupportCase_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityBuySupportCase" ADD CONSTRAINT "CommunityBuySupportCase_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
