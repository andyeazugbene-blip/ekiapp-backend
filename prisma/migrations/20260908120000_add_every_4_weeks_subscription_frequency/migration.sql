-- Client spec (Regular Delivery doc) lists four distinct frequency options:
-- "Weekly | Every 2 weeks | Every 4 weeks | Monthly". EVERY_4_WEEKS (28
-- fixed days) is additive and distinct from the existing MONTHLY (30 fixed
-- days) -- see FREQUENCY_DAYS in buyer-subscriptions.service.ts. Purely
-- additive: no existing row's frequency value changes.
ALTER TYPE "SubscriptionFrequency" ADD VALUE IF NOT EXISTS 'EVERY_4_WEEKS' BEFORE 'MONTHLY';
