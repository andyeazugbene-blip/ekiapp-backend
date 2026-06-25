ALTER TABLE "VerificationDocument"
ADD COLUMN "deleteAfterAt" TIMESTAMP(3),
ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "VerificationDocument_deleteAfterAt_deletedAt_idx" ON "VerificationDocument"("deleteAfterAt", "deletedAt");
CREATE INDEX "VerificationDocument_status_createdAt_idx" ON "VerificationDocument"("status", "createdAt");
