-- Production: Stripe Connect fields on Vendor

ALTER TABLE "Vendor" ADD COLUMN "stripeAccountId" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "stripeAccountStatus" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "stripePayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Vendor" ADD COLUMN "stripeChargesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Vendor" ADD COLUMN "stripeOnboardedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Vendor_stripeAccountId_key" ON "Vendor"("stripeAccountId");
