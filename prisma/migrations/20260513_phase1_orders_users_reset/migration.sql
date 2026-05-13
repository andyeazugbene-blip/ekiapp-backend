-- Phase 1: Extended OrderStatus, User fields, Order fields, PasswordResetToken

-- Add new values to OrderStatus enum
ALTER TYPE "OrderStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "OrderStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "OrderStatus" ADD VALUE 'DISPATCHED';
ALTER TYPE "OrderStatus" ADD VALUE 'IN_TRANSIT';
ALTER TYPE "OrderStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "OrderStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDED';

-- Add new columns to User
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "avatar" TEXT;
ALTER TABLE "User" ADD COLUMN "country" TEXT;

-- Add new columns to Vendor
ALTER TABLE "Vendor" ADD COLUMN "city" TEXT;

-- Add new columns to Order
ALTER TABLE "Order" ADD COLUMN "orderNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "notes" TEXT;
ALTER TABLE "Order" ADD COLUMN "deliveredAt" TIMESTAMP(3);

-- Backfill orderNumber for existing orders (use id as fallback)
UPDATE "Order" SET "orderNumber" = 'EKI-' || SUBSTRING("id" FROM 1 FOR 8) WHERE "orderNumber" IS NULL;

-- Make orderNumber NOT NULL and UNIQUE
ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET DEFAULT '';
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- Create PasswordResetToken table
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "PasswordResetToken"("token");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
