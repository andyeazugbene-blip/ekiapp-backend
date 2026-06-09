ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "costAmount" INTEGER,
  ADD COLUMN IF NOT EXISTS "costCurrency" TEXT;

ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "costAmount" INTEGER,
  ADD COLUMN IF NOT EXISTS "costCurrency" TEXT;

UPDATE "Product"
SET "costCurrency" = "currency"
WHERE "costAmount" IS NOT NULL
  AND ("costCurrency" IS NULL OR "costCurrency" = '');

UPDATE "OrderItem"
SET "costCurrency" = "currency"
WHERE "costAmount" IS NOT NULL
  AND ("costCurrency" IS NULL OR "costCurrency" = '');
