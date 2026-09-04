-- Architecture-mandated audit fields (gap closure): permission used,
-- before/after state, reason, IP/session. All nullable — existing writers
-- of AuditLog keep working unchanged; a null value means "not captured
-- for this call", never a fabricated one.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "permissionUsed" TEXT,
ADD COLUMN "beforeState" JSONB,
ADD COLUMN "afterState" JSONB,
ADD COLUMN "reason" TEXT,
ADD COLUMN "ipAddress" TEXT;
