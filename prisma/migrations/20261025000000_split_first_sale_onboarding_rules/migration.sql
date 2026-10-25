-- Notification Orchestration Spec v2 (2026-10-25): splits the merged
-- FIRST_SALE onboarding nudge into separate rules matching R03/R05/R06 of
-- the spec's 40-rule catalogue. FIRST_SALE itself narrows to R11 (first
-- paid order) only from this point on.

ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'FIRST_PRODUCT_REMINDER';
ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'DELIVERY_SETUP_REMINDER';
ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_REMINDER';
