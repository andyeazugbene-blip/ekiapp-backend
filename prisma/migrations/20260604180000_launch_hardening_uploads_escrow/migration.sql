CREATE TYPE "EscrowOtpChannel" AS ENUM ('SMS', 'EMAIL', 'SMS_EMAIL');

CREATE TYPE "UploadAssetStatus" AS ENUM ('REQUESTED', 'COMPLETED', 'FAILED');

ALTER TABLE "User" ADD COLUMN "smsMarketingConsentAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "smsTransactionalEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "UploadAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "publicUrl" TEXT,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "status" "UploadAssetStatus" NOT NULL DEFAULT 'REQUESTED',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EscrowProviderConfig" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutSupported" BOOLEAN NOT NULL DEFAULT false,
    "otpChannel" "EscrowOtpChannel" NOT NULL DEFAULT 'SMS',
    "protectionWindowHours" INTEGER NOT NULL DEFAULT 24,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EscrowProviderConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SmsDelivery" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'transactional',
    "provider" TEXT NOT NULL DEFAULT 'africastalking',
    "status" TEXT NOT NULL,
    "providerResponse" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SubscriptionPlanConfig"
ADD COLUMN "appleProductId" TEXT,
ADD COLUMN "googleProductId" TEXT;

CREATE UNIQUE INDEX "UploadAsset_key_key" ON "UploadAsset"("key");
CREATE INDEX "UploadAsset_ownerId_category_status_idx" ON "UploadAsset"("ownerId", "category", "status");
CREATE INDEX "UploadAsset_status_createdAt_idx" ON "UploadAsset"("status", "createdAt");
CREATE UNIQUE INDEX "EscrowProviderConfig_countryCode_currency_provider_key" ON "EscrowProviderConfig"("countryCode", "currency", "provider");
CREATE INDEX "EscrowProviderConfig_enabled_countryCode_idx" ON "EscrowProviderConfig"("enabled", "countryCode");
CREATE INDEX "SmsDelivery_to_createdAt_idx" ON "SmsDelivery"("to", "createdAt");
CREATE INDEX "SmsDelivery_status_createdAt_idx" ON "SmsDelivery"("status", "createdAt");
CREATE INDEX "SmsDelivery_purpose_createdAt_idx" ON "SmsDelivery"("purpose", "createdAt");

INSERT INTO "EscrowProviderConfig" (
  "id",
  "country",
  "countryCode",
  "currency",
  "provider",
  "enabled",
  "payoutSupported",
  "otpChannel",
  "protectionWindowHours",
  "updatedAt"
) VALUES
  ('escrow_provider_ghana_paystack_ghs', 'Ghana', 'GH', 'GHS', 'paystack', true, true, 'SMS', 24, CURRENT_TIMESTAMP),
  ('escrow_provider_nigeria_paystack_ngn', 'Nigeria', 'NG', 'NGN', 'paystack', true, true, 'SMS', 24, CURRENT_TIMESTAMP)
ON CONFLICT ("countryCode", "currency", "provider") DO NOTHING;
