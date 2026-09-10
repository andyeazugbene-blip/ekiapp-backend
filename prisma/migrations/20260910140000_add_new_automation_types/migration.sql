-- Final Client Decision 4: Automation Centre (11 modules).
-- Adds two new vendor-controlled automation types:
--   REORDER_REMINDER - triggers after completed+delivered orders
--   CHECKOUT_PAYMENT_FOLLOW_UP - triggers on failed/abandoned marketplace checkout

ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'REORDER_REMINDER';
ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'CHECKOUT_PAYMENT_FOLLOW_UP';
