-- Architecture doc §15.3 "Chargebacks" queue: a real Stripe chargeback
-- (charge.dispute.created webhook) previously only logged + emailed ops
-- with no DB row, so there was no admin-facing queue to work it from.
-- Distinct from the existing `Dispute` table, which is a buyer/vendor
-- order complaint Eki resolves internally, not a card-network chargeback.

-- CreateTable
CREATE TABLE "StripeDispute" (
    "id" TEXT NOT NULL,
    "stripeDisputeId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "checkoutId" TEXT,
    "buyerId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeDispute_stripeDisputeId_key" ON "StripeDispute"("stripeDisputeId");

-- CreateIndex
CREATE INDEX "StripeDispute_status_createdAt_idx" ON "StripeDispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StripeDispute_buyerId_idx" ON "StripeDispute"("buyerId");
