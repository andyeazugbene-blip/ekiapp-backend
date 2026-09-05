-- Cart currency architecture: one Cart row per (buyer, currency), not one
-- per buyer. A product's currency is fixed (inherited from its vendor,
-- immutable), so a buyer shopping across vendors in different currencies
-- gets a separate cart per currency instead of the previous blocked/
-- destructive "different currency, start a new cart" flow that cleared
-- their existing cart.

-- 1. Add the new currency column, defaulting to EUR for now.
ALTER TABLE "Cart" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EUR';

-- 2. Backfill each existing cart's currency from its own items' real
--    product currency. Every pre-existing cart has exactly one row per
--    buyer today (the constraint being replaced below), so this backfill
--    cannot produce a duplicate (buyerId, currency) pair. Empty carts keep
--    the EUR default.
UPDATE "Cart" c
SET "currency" = sub.currency
FROM (
  SELECT DISTINCT ON (ci."cartId") ci."cartId", UPPER(p."currency") AS currency
  FROM "CartItem" ci
  JOIN "Product" p ON p.id = ci."productId"
  ORDER BY ci."cartId", ci."createdAt" ASC
) sub
WHERE sub."cartId" = c.id;

-- 3. Replace the old one-cart-per-buyer constraint with one-cart-per-(buyer,currency).
DROP INDEX IF EXISTS "Cart_buyerId_key";
CREATE UNIQUE INDEX "Cart_buyerId_currency_key" ON "Cart"("buyerId", "currency");
CREATE INDEX "Cart_buyerId_idx" ON "Cart"("buyerId");
