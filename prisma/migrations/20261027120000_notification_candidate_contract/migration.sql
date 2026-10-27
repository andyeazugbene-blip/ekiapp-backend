CREATE TYPE "NotificationCandidateState" AS ENUM ('SCHEDULED', 'SUPPRESSED', 'QUEUED', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "NotificationPreferenceChannel" AS ENUM ('PUSH', 'IN_APP', 'EMAIL', 'SMS', 'WHATSAPP');
CREATE TYPE "NotificationPreferenceCategory" AS ENUM ('SERVICE', 'MARKETING');
CREATE TYPE "NotificationConsent" AS ENUM ('OPTED_IN', 'OPTED_OUT', 'NOT_REQUIRED_FOR_SERVICE', 'UNKNOWN');
CREATE TYPE "NotificationAttributionModel" AS ENUM ('DIRECT_TASK_COMPLETION', 'ASSISTED', 'NONE');
CREATE TYPE "NotificationPriority" AS ENUM ('P0', 'P1', 'P2', 'P3');
CREATE TYPE "NotificationRecipientRole" AS ENUM ('BUYER', 'VENDOR', 'ADMIN', 'ORGANISER', 'PARTICIPANT', 'SUPPLIER');

ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'OPENED';
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'SUPPRESSED';

ALTER TABLE "Notification"
  ADD COLUMN "ruleId" TEXT,
  ADD COLUMN "ruleVersion" INTEGER,
  ADD COLUMN "eventId" TEXT,
  ADD COLUMN "role" "NotificationRecipientRole",
  ADD COLUMN "category" "NotificationPreferenceCategory",
  ADD COLUMN "priority" "NotificationPriority",
  ADD COLUMN "entityType" TEXT,
  ADD COLUMN "entityId" TEXT,
  ADD COLUMN "taskEpisodeKey" TEXT,
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "candidateState" "NotificationCandidateState",
  ADD COLUMN "templateVersion" TEXT,
  ADD COLUMN "variantId" TEXT;

CREATE UNIQUE INDEX "Notification_taskEpisodeKey_key" ON "Notification"("taskEpisodeKey");
CREATE INDEX "Notification_ruleId_ruleVersion_idx" ON "Notification"("ruleId", "ruleVersion");
CREATE INDEX "Notification_candidateState_dueAt_idx" ON "Notification"("candidateState", "dueAt");

ALTER TABLE "NotificationDelivery"
  ADD COLUMN "templateVersion" TEXT,
  ADD COLUMN "variantId" TEXT;

CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "channel" "NotificationPreferenceChannel" NOT NULL,
  "category" "NotificationPreferenceCategory" NOT NULL,
  "consent" "NotificationConsent" NOT NULL DEFAULT 'UNKNOWN',
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "quietHoursStart" TEXT,
  "quietHoursEnd" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_userId_role_channel_category_key"
  ON "NotificationPreference"("userId", "role", "channel", "category");
CREATE INDEX "NotificationPreference_userId_role_idx"
  ON "NotificationPreference"("userId", "role");

ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NotificationOutcome" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "clickedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "completionEventId" TEXT,
  "attributionModel" "NotificationAttributionModel" NOT NULL DEFAULT 'NONE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationOutcome_notificationId_key"
  ON "NotificationOutcome"("notificationId");
ALTER TABLE "NotificationOutcome"
  ADD CONSTRAINT "NotificationOutcome_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunicationLog" ADD COLUMN "taskEpisodeKey" TEXT;
CREATE INDEX "CommunicationLog_taskEpisodeKey_channel_status_createdAt_idx"
  ON "CommunicationLog"("taskEpisodeKey", "channel", "status", "createdAt");
