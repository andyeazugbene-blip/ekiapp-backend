-- Batch 1: Domestic Africa Escrow — Paystack Integration & Foundation

-- New enums
CREATE TYPE "EscrowType" AS ENUM ('NONE', 'DOMESTIC_AFRICA');
CREATE TYPE "PaystackTxStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REVERSED');
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'RESOLVED_VENDOR', 'RESOLVED_BUYER', 'RESOLVED_PARTIAL');

-- New OrderStatus values
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_SECURED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'VENDOR_CONFIRMED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'AUTO_RELEASED';

-- Add escrow fields to Order
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "escrowType" "EscrowType" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "escrowExpiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "vendorConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "disputedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "autoReleasedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryAddress" TEXT;

-- Add trustScore to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "trustScore" INTEGER NOT NULL DEFAULT 50;

-- PaystackTransaction
CREATE TABLE IF NOT EXISTS "PaystackTransaction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PaystackTxStatus" NOT NULL DEFAULT 'PENDING',
    "paystackResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaystackTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PaystackTransaction_orderId_key" ON "PaystackTransaction"("orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "PaystackTransaction_reference_key" ON "PaystackTransaction"("reference");
CREATE INDEX IF NOT EXISTS "PaystackTransaction_reference_idx" ON "PaystackTransaction"("reference");
CREATE INDEX IF NOT EXISTS "PaystackTransaction_orderId_idx" ON "PaystackTransaction"("orderId");
CREATE INDEX IF NOT EXISTS "PaystackTransaction_status_createdAt_idx" ON "PaystackTransaction"("status", "createdAt");
ALTER TABLE "PaystackTransaction" ADD CONSTRAINT "PaystackTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- VendorBankAccount
CREATE TABLE IF NOT EXISTS "VendorBankAccount" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "paystackRecipientCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorBankAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "VendorBankAccount_vendorId_idx" ON "VendorBankAccount"("vendorId");
ALTER TABLE "VendorBankAccount" ADD CONSTRAINT "VendorBankAccount_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DeliveryOtp
CREATE TABLE IF NOT EXISTS "DeliveryOtp" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryOtp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryOtp_orderId_key" ON "DeliveryOtp"("orderId");
CREATE INDEX IF NOT EXISTS "DeliveryOtp_orderId_idx" ON "DeliveryOtp"("orderId");
CREATE INDEX IF NOT EXISTS "DeliveryOtp_expiresAt_idx" ON "DeliveryOtp"("expiresAt");
ALTER TABLE "DeliveryOtp" ADD CONSTRAINT "DeliveryOtp_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Dispute
CREATE TABLE IF NOT EXISTS "Dispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "fraudulent" BOOLEAN NOT NULL DEFAULT false,
    "refundAmount" INTEGER,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Dispute_orderId_key" ON "Dispute"("orderId");
CREATE INDEX IF NOT EXISTS "Dispute_status_createdAt_idx" ON "Dispute"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Dispute_buyerId_idx" ON "Dispute"("buyerId");
CREATE INDEX IF NOT EXISTS "Dispute_vendorId_idx" ON "Dispute"("vendorId");
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Order escrow index
CREATE INDEX IF NOT EXISTS "Order_escrowType_status_idx" ON "Order"("escrowType", "status");
