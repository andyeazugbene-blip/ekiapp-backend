-- CreateEnum
CREATE TYPE "DeliveryReferenceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'LABEL_GENERATED', 'HANDED_TO_COURIER', 'DELIVERED', 'COLLECTED', 'EXCEPTION', 'REVOKED');

-- CreateEnum
CREATE TYPE "DataAccessorRole" AS ENUM ('SUPPLIER', 'ORGANISER', 'ADMIN');

-- CreateEnum
CREATE TYPE "DataAccessCategory" AS ENUM ('DELIVERY_STATUS', 'CONTACT_CHANNEL', 'EMERGENCY_NUMBER', 'MANIFEST');

-- CreateEnum
CREATE TYPE "DataAccessAction" AS ENUM ('VIEWED', 'LABEL_GENERATED', 'MESSAGE_SENT', 'PROXY_CALL_STARTED', 'COURIER_SHARED', 'ACCESS_REVOKED', 'ADMIN_OVERRIDE');

-- CreateTable
CREATE TABLE "DeliveryReference" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "deliveryMethod" "CampaignDeliveryPreference" NOT NULL,
    "status" "DeliveryReferenceStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "deliveryArea" TEXT,
    "labelReference" TEXT,
    "externalDeliveryToken" TEXT,
    "courierProvider" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityBuyDataAccessLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contributionId" TEXT,
    "participantId" TEXT,
    "accessorAccountId" TEXT,
    "accessorUserId" TEXT NOT NULL,
    "accessorRole" "DataAccessorRole" NOT NULL,
    "dataCategory" "DataAccessCategory" NOT NULL,
    "action" "DataAccessAction" NOT NULL,
    "purposeCode" TEXT NOT NULL,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessExpiresAt" TIMESTAMP(3),
    "ipAddressHash" TEXT,
    "deviceOrSessionId" TEXT,
    "controlScope" TEXT,
    "adminOverrideId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityBuyDataAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReference_contributionId_key" ON "DeliveryReference"("contributionId");

-- CreateIndex
CREATE INDEX "DeliveryReference_campaignId_status_idx" ON "DeliveryReference"("campaignId", "status");

-- CreateIndex
CREATE INDEX "DeliveryReference_status_expiresAt_idx" ON "DeliveryReference"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CommunityBuyDataAccessLog_campaignId_accessedAt_idx" ON "CommunityBuyDataAccessLog"("campaignId", "accessedAt");

-- CreateIndex
CREATE INDEX "CommunityBuyDataAccessLog_accessorUserId_accessedAt_idx" ON "CommunityBuyDataAccessLog"("accessorUserId", "accessedAt");

-- CreateIndex
CREATE INDEX "CommunityBuyDataAccessLog_action_idx" ON "CommunityBuyDataAccessLog"("action");

-- CreateIndex
CREATE INDEX "CommunityBuyDataAccessLog_accessExpiresAt_idx" ON "CommunityBuyDataAccessLog"("accessExpiresAt");

-- AddForeignKey
ALTER TABLE "DeliveryReference" ADD CONSTRAINT "DeliveryReference_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReference" ADD CONSTRAINT "DeliveryReference_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "CampaignContribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
