-- S63: Foodstuff Subscription support cases.
CREATE TYPE "SubscriptionSupportCaseType" AS ENUM ('PAYMENT', 'RENEWAL', 'PRICE_CHANGE', 'STOCK', 'DELIVERY', 'CANCELLATION', 'REFUND', 'VENDOR_CONDUCT');

CREATE TABLE "SubscriptionSupportCase" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "renewalId" TEXT,
    "caseType" "SubscriptionSupportCaseType" NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "internalNotes" TEXT,
    "customerVisibleResponse" TEXT,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "escalatedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionSupportCase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SubscriptionSupportCase_subscriptionId_idx" ON "SubscriptionSupportCase"("subscriptionId");
CREATE INDEX "SubscriptionSupportCase_status_escalated_idx" ON "SubscriptionSupportCase"("status", "escalated");
ALTER TABLE "SubscriptionSupportCase" ADD CONSTRAINT "SubscriptionSupportCase_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BuyerSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
