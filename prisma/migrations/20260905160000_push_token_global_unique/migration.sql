-- A push token identifies one device installation, not one user. Making
-- it unique per (userId, token) allowed the SAME physical token to end up
-- attached to multiple users (e.g. logout, then a different account signs
-- in on the same device) — the old user would silently keep receiving
-- pushes on a device they're no longer signed into, and re-registration
-- created a second row instead of reassigning the existing one.

-- Dedupe first: keep only the most recent row per token (reflects who is
-- actually signed in on that device right now), in case any duplicate
-- token already exists across users.
DELETE FROM "PushToken" a
USING "PushToken" b
WHERE a.token = b.token
  AND a."createdAt" < b."createdAt";

ALTER TABLE "PushToken" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DROP INDEX IF EXISTS "PushToken_userId_token_key";
CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken"("token");
