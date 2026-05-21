import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";

const BCRYPT_ROUNDS = 12;

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
    return; // Admin already exists, don't create another
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
    logger.info("Existing user promoted to ADMIN");
    return;
  }

  // Create new admin user
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      name,
      password: passwordHash,
      role: UserRole.ADMIN,
    },
  });

  logger.info("Admin user bootstrapped");
}
