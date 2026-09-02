-- Diaspora Expansion foundation: Automation Engine, Regular Deliveries, and Community Buy (schema only — CommunityCampaign payments stay disabled by default via MarketConfiguration, set up lazily by the application, not seeded here).
-- CreateEnum
CREATE TYPE "AutomationType" AS ENUM ('FIRST_SALE', 'CART_RECOVERY', 'BUYER_WIN_BACK', 'REVIEW_REQUEST', 'LOW_STOCK_ALERT', 'BUYER_REFERRAL', 'PAYMENT_RECOVERY', 'RENEWAL_REMINDER', 'PRICE_APPROVAL_REMINDER', 'CAMPAIGN_MILESTONE', 'CAMPAIGN_DEADLINE', 'CAMPAIGN_REFUND_UPDATE');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('QUEUED', 'ELIGIBILITY_CHECK', 'SCHEDULED', 'SENT', 'SUPPRESSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "BuyerSubscriptionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'PAYMENT_ATTENTION', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('SCHEDULED', 'AWAITING_STOCK', 'AWAITING_PRICE_APPROVAL', 'READY_FOR_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED', 'PAID', 'ORDER_CREATED', 'SKIPPED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'CHANGES_REQUIRED', 'APPROVED', 'REJECTED', 'LIVE', 'PAUSED', 'CLOSING', 'SUCCEEDED', 'FAILED', 'REFUNDING', 'FULFILLING', 'COMPLETED', 'FINANCIALLY_CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContributionStatus" AS ENUM ('INITIATED', 'PAYMENT_PROCESSING', 'PAID', 'PAYMENT_FAILED', 'REFUND_PENDING', 'REFUND_PROCESSING', 'REFUNDED', 'REFUND_FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE 'AUTOMATION_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'COMMUNITY_CAMPAIGN_UPDATE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "marketingConsentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VendorAutomationSetting" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "AutomationType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAutomationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "type" "AutomationType" NOT NULL,
    "vendorId" TEXT,
    "recipientUserId" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT NOT NULL,
    "eligibleAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "suppressedReason" TEXT,
    "failureReason" TEXT,
    "communicationLogId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerPaymentMethod" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripePaymentMethodId" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionOffer" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "frequencies" "SubscriptionFrequency"[],
    "substitutionPolicy" TEXT,
    "renewalCutoffHours" INTEGER NOT NULL DEFAULT 24,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionOfferProduct" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionOfferProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerSubscription" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "status" "BuyerSubscriptionStatus" NOT NULL DEFAULT 'DRAFT',
    "frequency" "SubscriptionFrequency" NOT NULL,
    "deliveryAddressId" TEXT NOT NULL,
    "paymentMethodId" TEXT,
    "priceChangeApprovalLimitBps" INTEGER NOT NULL DEFAULT 500,
    "nextRenewalAt" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionItem" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Renewal" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "cycleDate" TIMESTAMP(3) NOT NULL,
    "status" "RenewalStatus" NOT NULL DEFAULT 'SCHEDULED',
    "stockConfirmedAt" TIMESTAMP(3),
    "stockConfirmedById" TEXT,
    "priceChangeRequestId" TEXT,
    "subtotalAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "orderId" TEXT,
    "failureReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Renewal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenewalItem" (
    "id" TEXT NOT NULL,
    "renewalId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "previousUnitPrice" INTEGER NOT NULL,
    "currentUnitPrice" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "stockAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenewalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceChangeRequest" (
    "id" TEXT NOT NULL,
    "previousUnitPrice" INTEGER NOT NULL,
    "proposedUnitPrice" INTEGER NOT NULL,
    "percentageDifference" DOUBLE PRECISION NOT NULL,
    "approvalLimitBps" INTEGER NOT NULL,
    "approvalRequired" BOOLEAN NOT NULL,
    "buyerDecision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPaymentAttempt" (
    "id" TEXT NOT NULL,
    "renewalId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "SubscriptionPaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionActionHistory" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionActionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganiserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganiserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProfile" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityCampaign" (
    "id" TEXT NOT NULL,
    "organiserId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "targetAmount" INTEGER NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewNotes" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "paidTotal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignParticipant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignContribution" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "ContributionStatus" NOT NULL DEFAULT 'INITIATED',
    "stripePaymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRefund" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "ContributionStatus" NOT NULL DEFAULT 'REFUND_PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketConfiguration" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "communityBuyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "communityBuyPaymentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "organiserApplicationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "supplierApplicationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "regularDeliveriesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorAutomationSetting_vendorId_idx" ON "VendorAutomationSetting"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorAutomationSetting_vendorId_type_key" ON "VendorAutomationSetting"("vendorId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_dedupeKey_key" ON "AutomationRun"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutomationRun_type_status_idx" ON "AutomationRun"("type", "status");

-- CreateIndex
CREATE INDEX "AutomationRun_recipientUserId_type_idx" ON "AutomationRun"("recipientUserId", "type");

-- CreateIndex
CREATE INDEX "AutomationRun_vendorId_type_createdAt_idx" ON "AutomationRun"("vendorId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationRun_status_scheduledFor_idx" ON "AutomationRun"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerPaymentMethod_stripePaymentMethodId_key" ON "BuyerPaymentMethod"("stripePaymentMethodId");

-- CreateIndex
CREATE INDEX "BuyerPaymentMethod_buyerId_idx" ON "BuyerPaymentMethod"("buyerId");

-- CreateIndex
CREATE INDEX "SubscriptionOffer_vendorId_isActive_idx" ON "SubscriptionOffer"("vendorId", "isActive");

-- CreateIndex
CREATE INDEX "SubscriptionOfferProduct_productId_idx" ON "SubscriptionOfferProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionOfferProduct_offerId_productId_key" ON "SubscriptionOfferProduct"("offerId", "productId");

-- CreateIndex
CREATE INDEX "BuyerSubscription_buyerId_status_idx" ON "BuyerSubscription"("buyerId", "status");

-- CreateIndex
CREATE INDEX "BuyerSubscription_offerId_idx" ON "BuyerSubscription"("offerId");

-- CreateIndex
CREATE INDEX "BuyerSubscription_status_nextRenewalAt_idx" ON "BuyerSubscription"("status", "nextRenewalAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionItem_subscriptionId_productId_key" ON "SubscriptionItem"("subscriptionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Renewal_priceChangeRequestId_key" ON "Renewal"("priceChangeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Renewal_orderId_key" ON "Renewal"("orderId");

-- CreateIndex
CREATE INDEX "Renewal_status_idx" ON "Renewal"("status");

-- CreateIndex
CREATE INDEX "Renewal_subscriptionId_status_idx" ON "Renewal"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Renewal_subscriptionId_cycleDate_key" ON "Renewal"("subscriptionId", "cycleDate");

-- CreateIndex
CREATE INDEX "RenewalItem_renewalId_idx" ON "RenewalItem"("renewalId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPaymentAttempt_idempotencyKey_key" ON "SubscriptionPaymentAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SubscriptionPaymentAttempt_renewalId_idx" ON "SubscriptionPaymentAttempt"("renewalId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPaymentAttempt_renewalId_attemptNumber_key" ON "SubscriptionPaymentAttempt"("renewalId", "attemptNumber");

-- CreateIndex
CREATE INDEX "SubscriptionActionHistory_subscriptionId_createdAt_idx" ON "SubscriptionActionHistory"("subscriptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrganiserProfile_userId_key" ON "OrganiserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProfile_vendorId_key" ON "SupplierProfile"("vendorId");

-- CreateIndex
CREATE INDEX "CommunityCampaign_status_country_idx" ON "CommunityCampaign"("status", "country");

-- CreateIndex
CREATE INDEX "CommunityCampaign_organiserId_idx" ON "CommunityCampaign"("organiserId");

-- CreateIndex
CREATE INDEX "CommunityCampaign_supplierId_idx" ON "CommunityCampaign"("supplierId");

-- CreateIndex
CREATE INDEX "CommunityCampaign_deadline_idx" ON "CommunityCampaign"("deadline");

-- CreateIndex
CREATE INDEX "CampaignParticipant_userId_idx" ON "CampaignParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignParticipant_campaignId_userId_key" ON "CampaignParticipant"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "CampaignContribution_campaignId_status_idx" ON "CampaignContribution"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignContribution_participantId_idx" ON "CampaignContribution"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRefund_contributionId_key" ON "CampaignRefund"("contributionId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRefund_idempotencyKey_key" ON "CampaignRefund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CampaignRefund_status_idx" ON "CampaignRefund"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketConfiguration_countryCode_key" ON "MarketConfiguration"("countryCode");

-- AddForeignKey
ALTER TABLE "VendorAutomationSetting" ADD CONSTRAINT "VendorAutomationSetting_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPaymentMethod" ADD CONSTRAINT "BuyerPaymentMethod_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionOffer" ADD CONSTRAINT "SubscriptionOffer_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionOfferProduct" ADD CONSTRAINT "SubscriptionOfferProduct_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "SubscriptionOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionOfferProduct" ADD CONSTRAINT "SubscriptionOfferProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerSubscription" ADD CONSTRAINT "BuyerSubscription_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerSubscription" ADD CONSTRAINT "BuyerSubscription_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "SubscriptionOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerSubscription" ADD CONSTRAINT "BuyerSubscription_deliveryAddressId_fkey" FOREIGN KEY ("deliveryAddressId") REFERENCES "BuyerAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerSubscription" ADD CONSTRAINT "BuyerSubscription_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "BuyerPaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BuyerSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BuyerSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_priceChangeRequestId_fkey" FOREIGN KEY ("priceChangeRequestId") REFERENCES "PriceChangeRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalItem" ADD CONSTRAINT "RenewalItem_renewalId_fkey" FOREIGN KEY ("renewalId") REFERENCES "Renewal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalItem" ADD CONSTRAINT "RenewalItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPaymentAttempt" ADD CONSTRAINT "SubscriptionPaymentAttempt_renewalId_fkey" FOREIGN KEY ("renewalId") REFERENCES "Renewal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionActionHistory" ADD CONSTRAINT "SubscriptionActionHistory_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BuyerSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganiserProfile" ADD CONSTRAINT "OrganiserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProfile" ADD CONSTRAINT "SupplierProfile_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityCampaign" ADD CONSTRAINT "CommunityCampaign_organiserId_fkey" FOREIGN KEY ("organiserId") REFERENCES "OrganiserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityCampaign" ADD CONSTRAINT "CommunityCampaign_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "SupplierProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignParticipant" ADD CONSTRAINT "CampaignParticipant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignParticipant" ADD CONSTRAINT "CampaignParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContribution" ADD CONSTRAINT "CampaignContribution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContribution" ADD CONSTRAINT "CampaignContribution_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "CampaignParticipant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRefund" ADD CONSTRAINT "CampaignRefund_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "CampaignContribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

