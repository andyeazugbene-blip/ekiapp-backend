-- Policy change (19 Oct 2026, explicit owner decision): a vendor may
-- publish and sell live the moment a listing is complete — identity
-- verification is now required only at payout/withdrawal time
-- (payouts.service.ts's createRequest), never to go live. computeProductStatus()
-- no longer produces PENDING_ACTIVATION at all; this is a one-time catch-up
-- for every row that was put there under the old policy. Every
-- PENDING_ACTIVATION row is, by definition, already complete (that status
-- only ever meant "complete, just waiting on verification"), so this is a
-- straight flip to PUBLISHED — no completeness recheck needed.
UPDATE "Product"
SET "status" = 'PUBLISHED', "isActive" = true, "publishedAt" = COALESCE("publishedAt", NOW())
WHERE "status" = 'PENDING_ACTIVATION';
