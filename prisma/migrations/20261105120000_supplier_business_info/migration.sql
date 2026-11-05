-- Supplier onboarding: business information and fulfilment capability.
ALTER TABLE "SupplierAccount" ADD COLUMN "businessName" TEXT;
ALTER TABLE "SupplierAccount" ADD COLUMN "businessRegistrationNumber" TEXT;
ALTER TABLE "SupplierAccount" ADD COLUMN "fulfilmentMethods" TEXT[] DEFAULT ARRAY[]::TEXT[];
