-- Renewal delivery-fee safety: the amount actually charged via Stripe at
-- attemptPayment() time must never drift from what convertPaidRenewalToOrder()
-- later records on the Order/Payment rows. Previously the delivery fee was
-- computed for the first time AFTER payment succeeded, using a fresh
-- DeliveryZone lookup, and silently defaulted to 0 if no zone matched -
-- meaning a DELIVERY-fulfilment renewal could be charged only its subtotal
-- while the Order/Payment/vendor-wallet-credit all recorded subtotal+fee
-- whenever a zone DID exist (crediting vendors for a fee never actually
-- collected), and silently charged/recorded £0 delivery whenever no zone
-- existed at all (even though checkout's one-off flow refuses to charge a
-- vendor with no delivery coverage in that market).
--
-- Fix: resolve the zone/fee once, BEFORE calling Stripe, store it on the
-- Renewal row, charge that exact total, and have order conversion read the
-- stored value back rather than re-deriving it.
ALTER TABLE "Renewal" ADD COLUMN "deliveryFeeAmount" INTEGER;
ALTER TABLE "Renewal" ADD COLUMN "deliveryZoneId" TEXT;

ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_deliveryZoneId_fkey"
  FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
