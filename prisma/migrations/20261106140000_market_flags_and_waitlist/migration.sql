-- Community Buy Part L market flags. Defaults keep today's behaviour.
ALTER TABLE "MarketConfiguration" ADD COLUMN "organiserTopUpEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MarketConfiguration" ADD COLUMN "deadlineExtensionEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MarketConfiguration" ADD COLUMN "organiserFeeEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MarketConfiguration" ADD COLUMN "supportedPaymentMethods" TEXT[] DEFAULT ARRAY['CARD']::TEXT[];
ALTER TABLE "MarketConfiguration" ADD COLUMN "refundRoute" TEXT NOT NULL DEFAULT 'ORIGINAL_PAYMENT_METHOD';
ALTER TABLE "MarketConfiguration" ADD COLUMN "marketRefundTimeframe" TEXT NOT NULL DEFAULT '5 to 10 business days';

-- CB02: "Notify me when available".
CREATE TABLE "MarketAvailabilityRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketAvailabilityRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketAvailabilityRequest_userId_market_key" ON "MarketAvailabilityRequest"("userId", "market");
CREATE INDEX "MarketAvailabilityRequest_market_notifiedAt_idx" ON "MarketAvailabilityRequest"("market", "notifiedAt");
ALTER TABLE "MarketAvailabilityRequest" ADD CONSTRAINT "MarketAvailabilityRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
