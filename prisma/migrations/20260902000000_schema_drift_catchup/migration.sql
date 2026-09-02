-- Catches up migration history to schema.prisma, discovered by applying
-- the full migration chain to a genuinely fresh local database during QA
-- (production's DB apparently had these applied by hand at some point —
-- prisma migrate deploy against a truly empty DB was failing before this).
-- Entirely additive/safe: new nullable columns, new default values (future
-- inserts only, no existing rows touched), 3 new tables + their indexes,
-- and dropping one confirmed-orphaned enum (GiftCardStatus — no column in
-- this database uses it, and schema.prisma no longer references it).
--
-- AlterTable
ALTER TABLE "BuyerWallet" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "BuyerWalletTransaction" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "Checkout" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "CommissionTier" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DeliveryZone" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "currency" SET DEFAULT 'EUR',
ALTER COLUMN "orderNumber" DROP DEFAULT;

-- AlterTable
ALTER TABLE "OrderItem" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "PayoutRequest" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "Referral" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "SellerPlan" ADD COLUMN     "customerDatabase" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxBundles" INTEGER,
ADD COLUMN     "maxCoupons" INTEGER,
ADD COLUMN     "orderManagement" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "professionalStorefront" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "repeatBuyerMarketing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "storeLinkSharing" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "stripeVerificationSessionId" TEXT,
ADD COLUMN     "verificationFailureReason" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Wallet" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "WalletTransaction" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- DropEnum
DROP TYPE "GiftCardStatus";

-- CreateTable
CREATE TABLE "CommunicationLog" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "recipientType" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipientType" TEXT NOT NULL DEFAULT 'BUYER',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledCommunication" (
    "id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateKey" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledCommunication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunicationLog_recipientId_idx" ON "CommunicationLog"("recipientId");

-- CreateIndex
CREATE INDEX "CommunicationLog_eventKey_idx" ON "CommunicationLog"("eventKey");

-- CreateIndex
CREATE INDEX "CommunicationLog_createdAt_idx" ON "CommunicationLog"("createdAt");

-- CreateIndex
CREATE INDEX "CommunicationLog_recipientType_createdAt_idx" ON "CommunicationLog"("recipientType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationTemplate_key_key" ON "CommunicationTemplate"("key");

-- CreateIndex
CREATE INDEX "ScheduledCommunication_status_scheduledFor_idx" ON "ScheduledCommunication"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ScheduledCommunication_createdBy_idx" ON "ScheduledCommunication"("createdBy");

