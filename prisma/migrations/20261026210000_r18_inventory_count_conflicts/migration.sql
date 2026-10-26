ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INVENTORY_ALERT';

CREATE TABLE "ProductInventoryCount" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "physicalQuantity" INTEGER NOT NULL,
    "outstandingOrderQuantity" INTEGER NOT NULL,
    "shortfallQuantity" INTEGER NOT NULL,
    "stockVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductInventoryCount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductInventoryCount_productId_createdAt_idx" ON "ProductInventoryCount"("productId", "createdAt");

ALTER TABLE "ProductInventoryCount" ADD CONSTRAINT "ProductInventoryCount_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
