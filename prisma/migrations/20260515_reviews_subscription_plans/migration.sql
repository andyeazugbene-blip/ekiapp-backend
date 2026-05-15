-- Add ReviewStatus enum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'HIDDEN', 'REJECTED');

-- Add GROWTH and PRO to SubscriptionPlan enum
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'GROWTH';
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'PRO';

-- Create Review table
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT,
    "orderId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "moderatedBy" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one review per buyer+order+product
CREATE UNIQUE INDEX "Review_buyerId_orderId_productId_key" ON "Review"("buyerId", "orderId", "productId");

-- Indexes for efficient queries
CREATE INDEX "Review_vendorId_status_idx" ON "Review"("vendorId", "status");
CREATE INDEX "Review_productId_status_idx" ON "Review"("productId", "status");
CREATE INDEX "Review_buyerId_idx" ON "Review"("buyerId");
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");
