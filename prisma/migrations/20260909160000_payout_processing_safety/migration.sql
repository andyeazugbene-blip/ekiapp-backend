-- P0 fix: vendor payout status could previously go straight from APPROVED
-- to PAID with the real Stripe Connect transfer attempted afterward — a
-- crash or thrown error there left the request permanently recorded as
-- "paid" even if the money never actually moved, with no recovery path.
-- PROCESSING/ON_HOLD mirror the equivalent, already-safe
-- CampaignSupplierPayment.status states used for Community Buy settlement.
-- Purely additive: two new enum values, two new nullable columns, no
-- existing row's status or data is affected.
ALTER TYPE "PayoutRequestStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "PayoutRequestStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';

ALTER TABLE "PayoutRequest" ADD COLUMN "stripeTransferId" TEXT;
ALTER TABLE "PayoutRequest" ADD COLUMN "holdReason" TEXT;
