-- CreateEnum
CREATE TYPE "CommunityBuyPaymentMode" AS ENUM ('PAY_NOW_REFUND_ON_FAILURE', 'AUTHORISE_THEN_CAPTURE', 'PLEDGE_THEN_CHARGE');

-- AlterTable
ALTER TABLE "MarketConfiguration" ADD COLUMN     "communityBuyPaymentMode" "CommunityBuyPaymentMode";


-- Backfill: any market that already has communityBuyPaymentsEnabled=true
-- is, by definition, already running the only charge flow that exists
-- (campaign-contributions.service.ts's pay-now/refund-on-failure model,
-- doc §9). Tagging it explicitly here changes zero runtime behavior for
-- that market — it only makes the mode auditable instead of implicit.
-- Any market NOT already enabled gets no mode (null), which the updated
-- isCommunityBuyPaymentsEnabled() check correctly treats as blocked.
UPDATE "MarketConfiguration"
SET "communityBuyPaymentMode" = 'PAY_NOW_REFUND_ON_FAILURE'
WHERE "communityBuyPaymentsEnabled" = true;
