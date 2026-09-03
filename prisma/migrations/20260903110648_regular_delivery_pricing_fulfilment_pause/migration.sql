-- spec §22/§23/§31 — Regular Delivery offer pricing rules, fulfilment
-- rules, and per-product renewal pause.

-- CreateEnum
CREATE TYPE "OfferSubstitutionMode" AS ENUM ('NO_SUBSTITUTION', 'ASK_BUYER', 'ALLOW_SIMILAR');

-- AlterTable
ALTER TABLE "SubscriptionOffer"
  ADD COLUMN "substitutionMode" "OfferSubstitutionMode" NOT NULL DEFAULT 'ASK_BUYER',
  ADD COLUMN "fulfilmentMethod" "FulfilmentMethod" NOT NULL DEFAULT 'DELIVERY',
  ADD COLUMN "preparationHours" INTEGER,
  ADD COLUMN "discountPercent" INTEGER,
  ADD COLUMN "maxPriceIncreaseApprovalBps" INTEGER;

-- AlterTable
ALTER TABLE "SubscriptionOfferProduct"
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "pauseReason" TEXT,
  ADD COLUMN "pauseExpectedReturnAt" TIMESTAMP(3);
