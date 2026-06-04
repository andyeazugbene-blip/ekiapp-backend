ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ADMIN_BROADCAST';

CREATE TABLE IF NOT EXISTS "AdminRole" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdminRoleAssignment" (
  "id" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminRoleAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdminRole_name_key" ON "AdminRole"("name");
CREATE INDEX IF NOT EXISTS "AdminRole_isSystem_name_idx" ON "AdminRole"("isSystem", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "AdminRoleAssignment_roleId_userId_key" ON "AdminRoleAssignment"("roleId", "userId");
CREATE INDEX IF NOT EXISTS "AdminRoleAssignment_userId_idx" ON "AdminRoleAssignment"("userId");
CREATE INDEX IF NOT EXISTS "AdminRoleAssignment_roleId_idx" ON "AdminRoleAssignment"("roleId");

ALTER TABLE "AdminRoleAssignment"
  ADD CONSTRAINT "AdminRoleAssignment_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdminRoleAssignment"
  ADD CONSTRAINT "AdminRoleAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
