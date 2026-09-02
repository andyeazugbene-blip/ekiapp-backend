-- Catches up migration history to schema.prisma, discovered by applying
-- the full migration chain to a genuinely fresh local database during QA
-- (production's DB apparently had these applied by hand at some point —
-- prisma migrate deploy against a truly empty DB was failing before this).
-- Entirely additive/safe: new nullable columns, new default values (future
-- inserts only, no existing rows touched), 3 new tables + their indexes,
-- and dropping one confirmed-orphaned enum (GiftCardStatus — no column in
-- this database uses it, and schema.prisma no longer references it).
--
-- 2026-09-02 correction: the first real production deploy attempt (P3018)
-- proved SellerPlan.customerDatabase already existed in production even
-- though it was absent from the local DB this migration was diffed
-- against — i.e. production's actual drift was never fully knowable from
-- here. Every statement below is now written IF (NOT) EXISTS so this
-- migration converges production to the same end state regardless of
-- exactly which of these changes a prior manual/out-of-band change already
-- made — it was never safe to assume the local diff was complete.
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
ALTER TABLE "SellerPlan" ADD COLUMN IF NOT EXISTS "customerDatabase" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "maxBundles" INTEGER,
ADD COLUMN IF NOT EXISTS "maxCoupons" INTEGER,
ADD COLUMN IF NOT EXISTS "orderManagement" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "professionalStorefront" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "repeatBuyerMarketing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "storeLinkSharing" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "stripeVerificationSessionId" TEXT,
ADD COLUMN IF NOT EXISTS "verificationFailureReason" TEXT,
ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Wallet" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "WalletTransaction" ALTER COLUMN "currency" SET DEFAULT 'EUR';

-- DropEnum
DROP TYPE IF EXISTS "GiftCardStatus";

-- CreateTable
CREATE TABLE IF NOT EXISTS "CommunicationLog" (
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
CREATE TABLE IF NOT EXISTS "CommunicationTemplate" (
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
CREATE TABLE IF NOT EXISTS "ScheduledCommunication" (
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
CREATE INDEX IF NOT EXISTS "CommunicationLog_recipientId_idx" ON "CommunicationLog"("recipientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CommunicationLog_eventKey_idx" ON "CommunicationLog"("eventKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CommunicationLog_createdAt_idx" ON "CommunicationLog"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CommunicationLog_recipientType_createdAt_idx" ON "CommunicationLog"("recipientType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationTemplate_key_key" ON "CommunicationTemplate"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScheduledCommunication_status_scheduledFor_idx" ON "ScheduledCommunication"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScheduledCommunication_createdBy_idx" ON "ScheduledCommunication"("createdBy");

