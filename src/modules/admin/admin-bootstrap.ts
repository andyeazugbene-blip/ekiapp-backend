import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { adminRolesService } from "./admin-roles.service";

const BCRYPT_ROUNDS = 12;

/**
 * Grants the bootstrap admin a real, explicit "Super Administrator"
 * AdminRoleAssignment row — required so adminRolesService.userPermissions()
 * doesn't have to fall back to its zero-assignments case for this account.
 * Idempotent (seedDefaultRoles + assignRole.upsert are both safe to repeat).
 */
async function grantSuperAdminRole(userId: string): Promise<void> {
  await adminRolesService.seedDefaultRoles();
  const role = await prisma.adminRole.findUnique({ where: { name: "Super Administrator" } });
  if (!role) {
    logger.warn("Super Administrator role not found after seeding — bootstrap admin has no explicit role assignment");
    return;
  }
  await adminRolesService.assignRole(role.id, userId);
}

/**
 * Bootstrap the first admin user if none exists.
 * Only runs when ADMIN_EMAIL and ADMIN_PASSWORD env vars are set.
 * Safe to call on every startup — idempotent.
 */
export async function bootstrapAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME ?? "Admin";

  if (!email || !password) {
    return; // Not configured, skip silently
  }

  if (password.length < 12) {
    logger.warn("ADMIN_PASSWORD must be at least 12 characters. Skipping bootstrap.");
    return;
  }

  // Check if any admin exists
  const existingAdmin = await prisma.user.findFirst({
    where: { role: UserRole.ADMIN },
    select: { id: true },
  });

  if (existingAdmin) {
    // Don't create another admin — but backfill a real role assignment if
    // this admin (very plausibly the one this exact bootstrap created,
    // before Super Administrator assignment existed) has none yet. Without
    // this, the account keeps relying on userPermissions()'s zero-
    // assignments fallback, which is being tightened to fail closed.
    const hasAssignment = await prisma.adminRoleAssignment.findFirst({ where: { userId: existingAdmin.id }, select: { id: true } });
    if (!hasAssignment) {
      await grantSuperAdminRole(existingAdmin.id).catch((error) => {
        logger.warn("Could not backfill Super Administrator role for existing bootstrap admin", { error: String(error) });
      });
    }
    return;
  }

  // Check if user with this email exists
  const existingUser = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });

  if (existingUser) {
    // Promote existing user to admin
    await prisma.user.update({
      where: { id: existingUser.id },
      data: { role: UserRole.ADMIN, tokenVersion: { increment: 1 } },
    });
    await grantSuperAdminRole(existingUser.id).catch((error) => {
      logger.warn("Could not grant Super Administrator role to promoted bootstrap admin", { error: String(error) });
    });
    logger.info("Existing user promoted to ADMIN");
    return;
  }

  // Create new admin user
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const created = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      name,
      password: passwordHash,
      role: UserRole.ADMIN,
    },
  });
  await grantSuperAdminRole(created.id).catch((error) => {
    logger.warn("Could not grant Super Administrator role to newly created bootstrap admin", { error: String(error) });
  });

  logger.info("Admin user bootstrapped");
}
