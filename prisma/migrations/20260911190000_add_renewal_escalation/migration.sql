-- Regular Delivery Admin Escalation: mirrors CampaignRefund's escalation
-- fields (same idempotency-marker pattern). Additive, nullable/defaulted —
-- safe on existing rows.
ALTER TABLE "Renewal" ADD COLUMN "escalated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Renewal" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "Renewal" ADD COLUMN "escalatedById" TEXT;
ALTER TABLE "Renewal" ADD COLUMN "escalatedReason" TEXT;
