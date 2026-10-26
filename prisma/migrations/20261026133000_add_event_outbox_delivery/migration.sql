CREATE TYPE "EventDeliveryStatus" AS ENUM ('LOG_ONLY', 'PENDING', 'PROCESSING', 'DELIVERED', 'DEAD');

ALTER TABLE "Event"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "dedupeKey" TEXT,
  ADD COLUMN "deliveryStatus" "EventDeliveryStatus" NOT NULL DEFAULT 'LOG_ONLY',
  ADD COLUMN "deliveryAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "lastDeliveryError" TEXT;

CREATE UNIQUE INDEX "Event_dedupeKey_key" ON "Event"("dedupeKey");
CREATE INDEX "Event_deliveryStatus_availableAt_idx" ON "Event"("deliveryStatus", "availableAt");