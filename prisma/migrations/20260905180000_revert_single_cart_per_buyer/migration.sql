-- Revert: one cart per buyer again. Multi-currency shopping is now handled
-- by checkout-time backend FX normalization into a single checkout
-- currency (see fx-rates.ts / payments.service.ts), not by giving each
-- currency its own cart — the buyer can mix EUR/USD/GBP items in ONE cart.

-- Merge: for any buyer who ended up with more than one Cart row (from the
-- now-reverted per-currency-cart design), keep their most-recently-updated
-- cart as canonical and move every other cart's items onto it. A product's
-- currency is fixed per-product, so the same product could never have
-- existed in two of a buyer's currency-carts — no item-level conflict is
-- possible here.
WITH ranked AS (
  SELECT id, "buyerId",
         ROW_NUMBER() OVER (PARTITION BY "buyerId" ORDER BY "updatedAt" DESC) AS rn
  FROM "Cart"
),
canonical AS (
  SELECT "buyerId", id AS canonical_id FROM ranked WHERE rn = 1
)
UPDATE "CartItem" ci
SET "cartId" = canonical.canonical_id
FROM "Cart" c
JOIN canonical ON canonical."buyerId" = c."buyerId"
WHERE ci."cartId" = c.id AND c.id <> canonical.canonical_id;

WITH ranked AS (
  SELECT id, "buyerId",
         ROW_NUMBER() OVER (PARTITION BY "buyerId" ORDER BY "updatedAt" DESC) AS rn
  FROM "Cart"
)
DELETE FROM "Cart" WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

DROP INDEX IF EXISTS "Cart_buyerId_currency_key";
DROP INDEX IF EXISTS "Cart_buyerId_idx";
ALTER TABLE "Cart" DROP COLUMN "currency";
CREATE UNIQUE INDEX "Cart_buyerId_key" ON "Cart"("buyerId");
