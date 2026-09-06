-- Vendor multi-market support. Vendor.country/Vendor.currency remain the
-- vendor's PRIMARY market (unchanged — every existing single-country call
-- site keeps working against it with zero behavior change). This table is
-- purely additive: a vendor may hold more than one active market assignment,
-- each independently resolving its own currency, so operating in two markets
-- never mixes their currencies or configuration.
--
-- Schema only. Existing vendors are backfilled by a separate TypeScript
-- script (scripts/backfill-vendor-market-assignments.ts) that reuses the
-- real resolveMarketCode() resolver from src/shared/currency.ts instead of
-- duplicating country-name matching in SQL — see that script for exactly how
-- each existing vendor's current country becomes their initial assignment.
CREATE TABLE "VendorMarketAssignment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorMarketAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorMarketAssignment_vendorId_marketCode_key" ON "VendorMarketAssignment"("vendorId", "marketCode");
CREATE INDEX "VendorMarketAssignment_vendorId_enabled_idx" ON "VendorMarketAssignment"("vendorId", "enabled");
CREATE INDEX "VendorMarketAssignment_marketCode_enabled_idx" ON "VendorMarketAssignment"("marketCode", "enabled");

ALTER TABLE "VendorMarketAssignment" ADD CONSTRAINT "VendorMarketAssignment_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
