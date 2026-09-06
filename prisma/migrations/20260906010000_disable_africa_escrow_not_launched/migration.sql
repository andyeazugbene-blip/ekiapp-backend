-- Africa is a coded/supported region (Paystack domestic escrow flow) but is
-- not a launched market. The Nigeria/Ghana EscrowProviderConfig rows seeded
-- in 20260604180000_launch_hardening_uploads_escrow were left `enabled=true`
-- by default, meaning POST /api/paystack/initialize would accept a real,
-- live checkout for either country today with no launch decision behind it.
-- Disable both rather than removing the rows, so the feature stays fully
-- coded/testable and can be re-enabled with a single admin action
-- (PATCH /admin/escrow/providers/:id) whenever Africa actually launches.
UPDATE "EscrowProviderConfig"
SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "countryCode" IN ('NG', 'GH');
