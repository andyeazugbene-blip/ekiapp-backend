-- AlterTable
ALTER TABLE "SubscriptionOffer" ADD COLUMN     "renewalsPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "renewalsPausedAt" TIMESTAMP(3);
