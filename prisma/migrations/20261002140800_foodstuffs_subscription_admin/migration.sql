-- Foodstuffs Subscription admin module + payment recovery (handbook section 9).
-- Additive only.
ALTER TABLE "BuyerSubscription" ADD COLUMN "pausedReason" TEXT;
ALTER TABLE "BuyerSubscription" ADD COLUMN "pausedAt" TIMESTAMP(3);
ALTER TABLE "BuyerSubscription" ADD COLUMN "cancelReason" TEXT;

ALTER TABLE "Renewal" ADD COLUMN "nextRetryAt" TIMESTAMP(3);
ALTER TABLE "Renewal" ADD COLUMN "awaitingStockSince" TIMESTAMP(3);

CREATE INDEX "Renewal_status_nextRetryAt_idx" ON "Renewal"("status", "nextRetryAt");
