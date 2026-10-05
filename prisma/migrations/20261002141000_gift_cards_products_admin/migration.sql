-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'REDEEMED', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Reward" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GiftCard" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "adminUnpublishedAt" TIMESTAMP(3),
ADD COLUMN "adminUnpublishedReason" TEXT,
ADD COLUMN "adminUnpublishedById" TEXT;

-- AlterTable
ALTER TABLE "PurchasedGiftCard" ADD COLUMN "code" TEXT,
ADD COLUMN "remainingBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "status" "GiftCardStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
ADD COLUMN "paidAt" TIMESTAMP(3),
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "statusReason" TEXT,
ADD COLUMN "statusChangedAt" TIMESTAMP(3),
ADD COLUMN "statusChangedById" TEXT;

-- Legacy rows: there was never a redemption path or a payment-confirmed marker,
-- so they stay PENDING_PAYMENT (hidden, not redeemable) unless already flagged
-- redeemed. Ops can reconcile genuinely paid legacy cards against Stripe.
UPDATE "PurchasedGiftCard" SET "status" = 'REDEEMED' WHERE "isRedeemed" = true;

-- CreateTable
CREATE TABLE "GiftCardRedemption" (
    "id" TEXT NOT NULL,
    "purchasedGiftCardId" TEXT NOT NULL,
    "redeemerId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "orderId" TEXT,
    "walletTransactionId" TEXT,
    "balanceAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchasedGiftCard_code_key" ON "PurchasedGiftCard"("code");

-- CreateIndex
CREATE INDEX "PurchasedGiftCard_status_createdAt_idx" ON "PurchasedGiftCard"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchasedGiftCard_stripePaymentIntentId_idx" ON "PurchasedGiftCard"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "GiftCardRedemption_purchasedGiftCardId_createdAt_idx" ON "GiftCardRedemption"("purchasedGiftCardId", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCardRedemption_redeemerId_idx" ON "GiftCardRedemption"("redeemerId");

-- AddForeignKey
ALTER TABLE "GiftCardRedemption" ADD CONSTRAINT "GiftCardRedemption_purchasedGiftCardId_fkey" FOREIGN KEY ("purchasedGiftCardId") REFERENCES "PurchasedGiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
