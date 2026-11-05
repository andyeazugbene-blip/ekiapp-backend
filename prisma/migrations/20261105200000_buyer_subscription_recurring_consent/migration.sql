-- Records when a buyer agreed to recurring payments. Nullable: older rows predate it.
ALTER TABLE "BuyerSubscription" ADD COLUMN "recurringConsentAt" TIMESTAMP(3);
