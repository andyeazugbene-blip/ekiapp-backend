-- CreateEnum
CREATE TYPE "FulfilmentStatus" AS ENUM ('AWAITING_INVENTORY_CONFIRMATION', 'INVENTORY_CONFIRMED', 'PACKING', 'READY_FOR_DISPATCH_OR_COLLECTION', 'DISPATCHED', 'COLLECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "FulfilmentMethod" AS ENUM ('DELIVERY', 'COLLECTION');

-- CreateTable
CREATE TABLE "CampaignFulfilment" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "FulfilmentStatus" NOT NULL DEFAULT 'AWAITING_INVENTORY_CONFIRMATION',
    "method" "FulfilmentMethod",
    "notes" TEXT,
    "estimatedReadyAt" TIMESTAMP(3),
    "inventoryConfirmedAt" TIMESTAMP(3),
    "packingStartedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignFulfilment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignFulfilment_campaignId_key" ON "CampaignFulfilment"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignFulfilment_status_idx" ON "CampaignFulfilment"("status");

-- AddForeignKey
ALTER TABLE "CampaignFulfilment" ADD CONSTRAINT "CampaignFulfilment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
