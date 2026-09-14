-- CreateEnum
CREATE TYPE "SupplierInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "CommunityCampaign" ADD COLUMN     "supplierAccountId" TEXT;

-- CreateTable
CREATE TABLE "SupplierInvitation" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "SupplierInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "termsSnapshot" JSONB NOT NULL,
    "declineReason" TEXT,
    "acceptedSupplierAccountId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvitation_token_key" ON "SupplierInvitation"("token");

-- CreateIndex
CREATE INDEX "SupplierInvitation_campaignId_idx" ON "SupplierInvitation"("campaignId");

-- CreateIndex
CREATE INDEX "SupplierInvitation_email_idx" ON "SupplierInvitation"("email");

-- CreateIndex
CREATE INDEX "CommunityCampaign_supplierAccountId_idx" ON "CommunityCampaign"("supplierAccountId");

-- AddForeignKey
ALTER TABLE "SupplierInvitation" ADD CONSTRAINT "SupplierInvitation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityCampaign" ADD CONSTRAINT "CommunityCampaign_supplierAccountId_fkey" FOREIGN KEY ("supplierAccountId") REFERENCES "SupplierAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
