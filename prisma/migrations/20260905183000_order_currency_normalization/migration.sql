-- Multi-currency checkout audit trail. Order.currency stays the vendor's
-- native currency (unchanged, still drives wallet/ledger crediting). These
-- new columns are only populated when a buyer's checkout currency differs
-- from this order's native currency — the authoritative, snapshotted
-- conversion used to fold this order into the ONE currency actually
-- charged. All nullable: null means no conversion was needed.
ALTER TABLE "Order"
  ADD COLUMN "checkoutCurrency" TEXT,
  ADD COLUMN "normalizedTotalAmount" INTEGER,
  ADD COLUMN "exchangeRate" DOUBLE PRECISION,
  ADD COLUMN "exchangeRateTimestamp" TIMESTAMP(3),
  ADD COLUMN "exchangeRateSource" TEXT;
