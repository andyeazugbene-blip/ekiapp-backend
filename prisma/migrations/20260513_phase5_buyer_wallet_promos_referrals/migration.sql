-- Phase 5: Buyer Wallet, Promo Codes, Referrals

-- User: add referral fields
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "User" ADD COLUMN "referredBy" TEXT;
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- Enums
CREATE TYPE "BuyerWalletTxType" AS ENUM ('TOP_UP', 'REFERRAL_BONUS', 'ORDER_DEBIT', 'REFUND_CREDIT', 'WITHDRAWAL');
CREATE TYPE "PromoType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- BuyerWallet
CREATE TABLE "BuyerWallet" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerWallet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BuyerWallet_buyerId_key" ON "BuyerWallet"("buyerId");

-- BuyerWalletTransaction
CREATE TABLE "BuyerWalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "type" "BuyerWalletTxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "description" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerWalletTransaction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BuyerWalletTransaction_walletId_createdAt_idx" ON "BuyerWalletTransaction"("walletId", "createdAt");
CREATE INDEX "BuyerWalletTransaction_buyerId_createdAt_idx" ON "BuyerWalletTransaction"("buyerId", "createdAt");
ALTER TABLE "BuyerWalletTransaction" ADD CONSTRAINT "BuyerWalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "BuyerWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PromoCode
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "PromoType" NOT NULL,
    "value" INTEGER NOT NULL,
    "minOrderAmount" INTEGER,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");
CREATE INDEX "PromoCode_code_isActive_idx" ON "PromoCode"("code", "isActive");
CREATE INDEX "PromoCode_isActive_validFrom_validUntil_idx" ON "PromoCode"("isActive", "validFrom", "validUntil");

-- PromoRedemption
CREATE TABLE "PromoRedemption" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "orderId" TEXT,
    "discountAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PromoRedemption_promoCodeId_buyerId_key" ON "PromoRedemption"("promoCodeId", "buyerId");
CREATE INDEX "PromoRedemption_buyerId_idx" ON "PromoRedemption"("buyerId");
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Referral
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "bonusAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");
CREATE INDEX "Referral_referrerId_idx" ON "Referral"("referrerId");
