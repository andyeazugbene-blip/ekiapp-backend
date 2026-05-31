-- AlterTable: add paymentIntentId to BuyerWalletTransaction
ALTER TABLE "BuyerWalletTransaction" ADD COLUMN IF NOT EXISTS "paymentIntentId" TEXT;

-- CreateIndex: unique constraint for wallet top-up idempotency
CREATE UNIQUE INDEX IF NOT EXISTS "BuyerWalletTransaction_paymentIntentId_type_key" ON "BuyerWalletTransaction"("paymentIntentId", "type");

-- Add CHECK constraint: BuyerWallet balance must never go negative
DO $$ BEGIN
  ALTER TABLE "BuyerWallet" ADD CONSTRAINT "BuyerWallet_balance_non_negative" CHECK ("balance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
