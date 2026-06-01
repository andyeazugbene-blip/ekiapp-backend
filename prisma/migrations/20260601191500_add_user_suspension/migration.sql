ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "isSuspended" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "suspendedReason" TEXT;

CREATE INDEX IF NOT EXISTS "User_isSuspended_idx" ON "User"("isSuspended");
