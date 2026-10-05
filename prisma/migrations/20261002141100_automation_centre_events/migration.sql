-- CreateEnum
CREATE TYPE "AutomationRuleState" AS ENUM ('DRAFT', 'TEST', 'ACTIVE', 'PAUSED', 'FAILED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "AutomationType" ADD VALUE 'VENDOR_TRIAL_ENDING';

-- AlterTable
ALTER TABLE "AutomationRun" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "channelResults" JSONB,
ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retryOfId" TEXT,
ADD COLUMN     "ruleKey" TEXT;

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT 'Eki Operations',
    "version" INTEGER NOT NULL DEFAULT 1,
    "relatedFeature" TEXT,
    "automationType" "AutomationType",
    "triggerDescription" TEXT NOT NULL,
    "conditions" JSONB,
    "exclusions" JSONB,
    "audience" TEXT,
    "timing" JSONB,
    "channels" JSONB,
    "state" "AutomationRuleState" NOT NULL DEFAULT 'ACTIVE',
    "stateBeforeStop" "AutomationRuleState",
    "stateReason" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastSkippedAt" TIMESTAMP(3),
    "lastSkipReason" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "actorType" TEXT,
    "actorId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "secondaryEntities" JSONB,
    "source" TEXT,
    "consentContext" JSONB,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRule_key_key" ON "AutomationRule"("key");

-- CreateIndex
CREATE INDEX "AutomationRule_state_idx" ON "AutomationRule"("state");

-- CreateIndex
CREATE INDEX "AutomationRule_automationType_idx" ON "AutomationRule"("automationType");

-- CreateIndex
CREATE INDEX "Event_name_occurredAt_idx" ON "Event"("name", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_entityType_entityId_idx" ON "Event"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Event_actorId_occurredAt_idx" ON "Event"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_occurredAt_idx" ON "Event"("occurredAt");

-- CreateIndex
CREATE INDEX "AutomationRun_retryOfId_idx" ON "AutomationRun"("retryOfId");

-- CreateIndex
CREATE INDEX "AutomationRun_ruleKey_createdAt_idx" ON "AutomationRun"("ruleKey", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationRun_createdAt_idx" ON "AutomationRun"("createdAt");

