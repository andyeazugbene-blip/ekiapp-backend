-- Migration: change all currency column defaults from 'usd' to 'eur' for Italian/EU marketplace.
-- Also updates existing 'usd' rows to 'eur'.

-- Schema default changes
ALTER TABLE "Product" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "Order" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "Checkout" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "OrderItem" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "Payment" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "Wallet" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "WalletTransaction" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "DeliveryZone" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "BuyerWallet" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "BuyerWalletTransaction" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "PayoutRequest" ALTER COLUMN "currency" SET DEFAULT 'eur';
ALTER TABLE "Referral" ALTER COLUMN "currency" SET DEFAULT 'eur';

-- Data migration: convert existing usd rows to eur
-- Only safe if the platform has not yet processed real USD payments.
-- If real USD data exists, this should be reviewed manually.
UPDATE "Product" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "Order" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "Checkout" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "OrderItem" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "Payment" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "Wallet" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "WalletTransaction" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "DeliveryZone" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "BuyerWallet" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "BuyerWalletTransaction" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "PayoutRequest" SET "currency" = 'eur' WHERE "currency" = 'usd';
UPDATE "Referral" SET "currency" = 'eur' WHERE "currency" = 'usd';
