-- Client spec (Community Buy doc, Screen CB67) requires a real supplier
-- Decline action alongside Accept — confirmed no such capability existed
-- anywhere in the backend before this migration. Purely additive: two new
-- nullable columns, no existing row affected, no data migration needed.
ALTER TABLE "CommunityCampaign" ADD COLUMN "supplierDeclinedAt" TIMESTAMP(3);
ALTER TABLE "CommunityCampaign" ADD COLUMN "supplierDeclineReason" TEXT;
