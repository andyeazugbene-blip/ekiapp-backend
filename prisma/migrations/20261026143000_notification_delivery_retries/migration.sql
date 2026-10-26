-- Per-channel retry and provider receipt state for notification candidates.
-- Existing notifications remain untouched and retain their current behavior.
CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'CANCELLED', 'DEAD'
);

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "communicationLogId" TEXT,
  "providerRef" TEXT,
  "lastError" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDelivery_communicationLogId_key"
  ON "NotificationDelivery"("communicationLogId");
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key"
  ON "NotificationDelivery"("notificationId", "channel");
CREATE INDEX "NotificationDelivery_status_availableAt_idx"
  ON "NotificationDelivery"("status", "availableAt");
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
