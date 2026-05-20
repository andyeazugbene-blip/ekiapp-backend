-- AlterTable: add paymentIntentId to BuyerWalletTransaction
ALTER TABLE "BuyerWalletTransaction" ADD COLUMN "paymentIntentId" TEXT;

-- CreateIndex: unique constraint for wallet top-up idempotency
CREATE UNIQUE INDEX "BuyerWalletTransaction_paymentIntentId_type_key" ON "BuyerWalletTransaction"("paymentIntentId", "type");

-- Add CHECK constraint: BuyerWallet balance must never go negative
ALTER TABLE "BuyerWallet" ADD CONSTRAINT "BuyerWallet_balance_non_negative" CHECK ("balance" >= 0);
