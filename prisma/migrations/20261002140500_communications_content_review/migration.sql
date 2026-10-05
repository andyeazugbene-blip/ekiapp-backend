-- W5: Communication Center + Content Review
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'PARTIALLY_DELIVERED', 'FAILED', 'CANCELLED');

ALTER TABLE "CommunicationLog" ADD COLUMN "broadcastId" TEXT,
ADD COLUMN "providerRef" TEXT,
ADD COLUMN "statusDetail" TEXT,
ADD COLUMN "deliveredAt" TIMESTAMP(3);

ALTER TABLE "PushTicket" ADD COLUMN "logId" TEXT;

ALTER TABLE "ScheduledCommunication" ADD COLUMN "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "category" TEXT NOT NULL DEFAULT 'marketing',
ADD COLUMN "deepLink" TEXT,
ADD COLUMN "audienceParams" JSONB,
ADD COLUMN "reason" TEXT,
ADD COLUMN "broadcastId" TEXT;

ALTER TABLE "ContentDecision" ADD COLUMN "action" TEXT;
ALTER TABLE "ContentReport" ADD COLUMN "decisionReason" TEXT;

CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'SENDING',
    "category" TEXT NOT NULL DEFAULT 'marketing',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "deepLink" TEXT,
    "templateKey" TEXT,
    "audience" TEXT NOT NULL,
    "audienceParams" JSONB,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "audienceTotal" INTEGER NOT NULL DEFAULT 0,
    "eligibility" JSONB,
    "channelResults" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "changedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Broadcast_idempotencyKey_key" ON "Broadcast"("idempotencyKey");
CREATE INDEX "Broadcast_status_createdAt_idx" ON "Broadcast"("status", "createdAt");
CREATE INDEX "Broadcast_createdById_idx" ON "Broadcast"("createdById");
CREATE INDEX "CommunicationLog_broadcastId_idx" ON "CommunicationLog"("broadcastId");
CREATE INDEX "PushTicket_logId_idx" ON "PushTicket"("logId");
CREATE UNIQUE INDEX "CommunicationTemplateVersion_templateKey_version_key" ON "CommunicationTemplateVersion"("templateKey", "version");
CREATE INDEX "CommunicationTemplateVersion_templateKey_createdAt_idx" ON "CommunicationTemplateVersion"("templateKey", "createdAt");
