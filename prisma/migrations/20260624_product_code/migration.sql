ALTER TABLE "Product" ADD COLUMN "productCode" TEXT;

WITH numbered AS (
  SELECT id, 'EKI-' || LPAD((10100 + ROW_NUMBER() OVER (ORDER BY "createdAt", id))::text, 6, '0') AS code
  FROM "Product"
)
UPDATE "Product"
SET "productCode" = numbered.code
FROM numbered
WHERE "Product".id = numbered.id;

CREATE UNIQUE INDEX "Product_productCode_key" ON "Product"("productCode");
CREATE INDEX "Product_productCode_idx" ON "Product"("productCode");
