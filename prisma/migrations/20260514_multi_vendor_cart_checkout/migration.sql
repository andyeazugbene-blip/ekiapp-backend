-- Multi-vendor cart + Checkout model

-- Remove single-vendor restriction from Cart
ALTER TABLE "Cart" DROP COLUMN IF EXISTS "vendorId";
DROP INDEX IF EXISTS "Cart_vendorId_idx";

-- Add Checkout table
CREATE TABLE "Checkout" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Checkout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Checkout_stripePaymentIntentId_key" ON "Checkout"("stripePaymentIntentId");
CREATE INDEX "Checkout_buyerId_idx" ON "Checkout"("buyerId");
CREATE INDEX "Checkout_status_idx" ON "Checkout"("status");

-- Add checkoutId, vendorId, platformFeeAmount, vendorEarnings to Order
ALTER TABLE "Order" ADD COLUMN "checkoutId" TEXT;
ALTER TABLE "Order" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "Order" ADD COLUMN "platformFeeAmount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "vendorEarnings" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Order_checkoutId_idx" ON "Order"("checkoutId");
CREATE INDEX "Order_vendorId_status_idx" ON "Order"("vendorId", "status");

ALTER TABLE "Order" ADD CONSTRAINT "Order_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "Checkout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
