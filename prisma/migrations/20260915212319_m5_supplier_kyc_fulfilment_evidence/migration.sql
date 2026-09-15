-- CreateEnum
CREATE TYPE "FulfilmentEventActorRole" AS ENUM ('SUPPLIER', 'ORGANISER', 'PARTICIPANT', 'ADMIN');

-- CreateEnum
CREATE TYPE "FulfilmentEventType" AS ENUM ('INVENTORY_CONFIRMED', 'PLAN_SET', 'PACKING_STARTED', 'READY', 'DISPATCHED', 'COLLECTED', 'COMPLETED', 'EXCEPTION', 'PARTICIPANT_RECEIPT_CONFIRMED', 'PARTICIPANT_PROBLEM_REPORTED');

-- AlterTable
ALTER TABLE "SupplierAccount" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "collectionCapacityPerDay" INTEGER,
ADD COLUMN     "stripeRequirementsDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignFulfilmentEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contributionId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorRole" "FulfilmentEventActorRole" NOT NULL,
    "eventType" "FulfilmentEventType" NOT NULL,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignFulfilmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignFulfilmentEvent_campaignId_createdAt_idx" ON "CampaignFulfilmentEvent"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignFulfilmentEvent_contributionId_idx" ON "CampaignFulfilmentEvent"("contributionId");

-- AddForeignKey
ALTER TABLE "CampaignFulfilmentEvent" ADD CONSTRAINT "CampaignFulfilmentEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
