-- Client feedback 2026-10-22: new vendor accounts got one welcome message
-- then silence — no reminder to finish setting up their store.
-- Adds one new automation type: REGISTRATION_REMINDER (day 1/day 3 after
-- account creation, for a VENDOR-role account with no Vendor profile yet —
-- see the long comment on detectRegistrationReminder in
-- automation.detectors.ts for why this isn't keyed on email verification).

ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'REGISTRATION_REMINDER';
