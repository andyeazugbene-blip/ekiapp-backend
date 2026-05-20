-- Phase 3: Data integrity CHECK constraints
-- All constraints are idempotent: uses DO blocks to skip if already present.

-- Wallet.pendingBalance >= 0
DO $$ BEGIN
  ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_pendingBalance_non_negative" CHECK ("pendingBalance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Wallet.availableBalance >= 0
DO $$ BEGIN
  ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_availableBalance_non_negative" CHECK ("availableBalance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- BuyerWallet.balance >= 0 (may already exist from Phase 1)
DO $$ BEGIN
  ALTER TABLE "BuyerWallet" ADD CONSTRAINT "BuyerWallet_balance_non_negative" CHECK ("balance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Product.stock >= 0
DO $$ BEGIN
  ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_non_negative" CHECK ("stock" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Payment.amount >= 0
DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_non_negative" CHECK ("amount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PayoutRequest.amount > 0
DO $$ BEGIN
  ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_amount_positive" CHECK ("amount" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- OrderItem.quantity > 0
DO $$ BEGIN
  ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_quantity_positive" CHECK ("quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PromoCode.usedCount >= 0 (may already exist from Phase 2)
DO $$ BEGIN
  ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_usedCount_non_negative" CHECK ("usedCount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Review.rating BETWEEN 1 AND 5 (may already exist from Phase 2)
DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
