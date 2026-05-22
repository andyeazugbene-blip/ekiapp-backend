-- Database-level CHECK constraints for monetary and quantity fields.
-- Belt-and-braces: application layer already guards these, but DB constraints
-- prevent regressions from direct SQL, buggy migrations, or future refactors.

DO $$ BEGIN
  ALTER TABLE "Wallet" ADD CONSTRAINT wallet_pending_nonneg CHECK ("pendingBalance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Wallet" ADD CONSTRAINT wallet_avail_nonneg CHECK ("availableBalance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "BuyerWallet" ADD CONSTRAINT bw_nonneg CHECK (balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Product" ADD CONSTRAINT product_stock_nonneg CHECK (stock >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT payment_amount_nonneg CHECK (amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutRequest" ADD CONSTRAINT payout_amount_pos CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "OrderItem" ADD CONSTRAINT oi_qty_pos CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PromoCode" ADD CONSTRAINT promo_usedcount_nonneg CHECK ("usedCount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT review_rating_range CHECK (rating BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
