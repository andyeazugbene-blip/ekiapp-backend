-- Client correction: Community Buy supplier is an optional fulfilment
-- choice, never a prerequisite for campaign publication/LIVE.
--
-- - supplierId becomes nullable (self-fulfilled campaigns have none).
-- - fulfilmentOwner records the organiser's explicit choice (SELF/SUPPLIER).
--   Existing rows all had a required supplier, so they backfill to SUPPLIER
--   by the column default — no ambiguity, no guessed data.

CREATE TYPE "CampaignFulfilmentOwner" AS ENUM ('SELF', 'SUPPLIER');

ALTER TABLE "CommunityCampaign" ALTER COLUMN "supplierId" DROP NOT NULL;

ALTER TABLE "CommunityCampaign" ADD COLUMN "fulfilmentOwner" "CampaignFulfilmentOwner" NOT NULL DEFAULT 'SUPPLIER';
