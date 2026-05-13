-- Phase 3: Delivery Methods, Shipments, DeliveryZone enhancements

-- Add new columns to DeliveryZone
ALTER TABLE "DeliveryZone" ADD COLUMN "flag" TEXT;
ALTER TABLE "DeliveryZone" ADD COLUMN "vendorId" TEXT;
CREATE INDEX "DeliveryZone_vendorId_isActive_idx" ON "DeliveryZone"("vendorId", "isActive");

-- DeliveryMethod
CREATE TABLE "DeliveryMethod" (
    "id" TEXT NOT NULL,
    "deliveryZoneId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceAmount" INTEGER NOT NULL,
    "minDays" INTEGER NOT NULL,
    "maxDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryMethod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeliveryMethod_deliveryZoneId_isActive_idx" ON "DeliveryMethod"("deliveryZoneId", "isActive");
ALTER TABLE "DeliveryMethod" ADD CONSTRAINT "DeliveryMethod_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ShipmentStatus enum
CREATE TYPE "ShipmentStatus" AS ENUM ('PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'DELAYED');

-- Shipment
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PROCESSING',
    "estimatedDeliveryAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Shipment_orderId_key" ON "Shipment"("orderId");
CREATE INDEX "Shipment_vendorId_status_idx" ON "Shipment"("vendorId", "status");
CREATE INDEX "Shipment_status_idx" ON "Shipment"("status");
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");
