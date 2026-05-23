import crypto from "crypto";

import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const BACKUP_CODE_COUNT = 10;
const BCRYPT_ROUNDS = 10;

/**
 * POST /api/admin/2fa/setup
 * Generate a TOTP secret and return the otpauth URL for QR code scanning.
 * Does NOT enable 2FA until verified.
 */
export async function setup2fa(request: Request, response: Response): Promise<void> {
  const userId = request.user!.id;

  // Check if already enabled
  const existing = await prisma.adminTwoFactor.findUnique({ where: { userId } });
  if (existing?.enabled) {
    throw new AppError("2FA is already enabled. Disable it first to reconfigure.", 409);
  }

  const secret = authenticator.generateSecret();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  const otpauthUrl = authenticator.keyuri(user!.email, "EkiMarketplace", secret);

  // Upsert the record (not yet enabled)
  await prisma.adminTwoFactor.upsert({
    where: { userId },
    create: { userId, secret, enabled: false },
    update: { secret, enabled: false, backupCodes: [] },
  });

  response.status(200).json({ secret, otpauthUrl });
}

/**
 * POST /api/admin/2fa/verify
 * Verify a TOTP code to enable 2FA. Also generates backup codes.
 */
export async function verify2fa(request: Request, response: Response): Promise<void> {
  const userId = request.user!.id;
  const { code } = request.body as { code?: string };

  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new AppError("A valid 6-digit code is required", 400);
  }

  const record = await prisma.adminTwoFactor.findUnique({ where: { userId } });
  if (!record) {
    throw new AppError("Call /2fa/setup first", 400);
  }
  if (record.enabled) {
    throw new AppError("2FA is already enabled", 409);
  }

  const valid = authenticator.check(code, record.secret);
  if (!valid) {
    throw new AppError("Invalid TOTP code", 401);
  }

  // Generate backup codes
  const rawBackupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
    crypto.randomBytes(4).toString("hex"), // 8-char hex codes
  );

  const hashedCodes = await Promise.all(
    rawBackupCodes.map((c) => bcrypt.hash(c, BCRYPT_ROUNDS)),
  );

  await prisma.adminTwoFactor.update({
    where: { userId },
    data: { enabled: true, backupCodes: hashedCodes },
  });

  response.status(200).json({
    message: "2FA enabled successfully",
    backupCodes: rawBackupCodes,
    warning: "Store these backup codes securely. They will not be shown again.",
  });
}

/**
 * POST /api/admin/2fa/disable
 * Disable 2FA. Requires a valid TOTP code or backup code.
 */
export async function disable2fa(request: Request, response: Response): Promise<void> {
  const userId = request.user!.id;
  const { code } = request.body as { code?: string };

  if (!code || typeof code !== "string") {
    throw new AppError("A TOTP code or backup code is required", 400);
  }

  const record = await prisma.adminTwoFactor.findUnique({ where: { userId } });
  if (!record || !record.enabled) {
    throw new AppError("2FA is not enabled", 400);
  }

  // Try TOTP first
  const totpValid = authenticator.check(code, record.secret);

  if (!totpValid) {
    // Try backup codes
    const backupValid = await tryBackupCode(record.id, record.backupCodes, code);
    if (!backupValid) {
      throw new AppError("Invalid code", 401);
    }
  }

  await prisma.adminTwoFactor.update({
    where: { userId },
    data: { enabled: false, secret: "", backupCodes: [] },
  });

  response.status(200).json({ message: "2FA disabled successfully" });
}

/**
 * POST /api/admin/2fa/backup-codes/regenerate
 * Regenerate backup codes. Requires a valid TOTP code.
 */
export async function regenerateBackupCodes(request: Request, response: Response): Promise<void> {
  const userId = request.user!.id;
  const { code } = request.body as { code?: string };

  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new AppError("A valid 6-digit TOTP code is required", 400);
  }

  const record = await prisma.adminTwoFactor.findUnique({ where: { userId } });
  if (!record || !record.enabled) {
    throw new AppError("2FA is not enabled", 400);
  }

  const valid = authenticator.check(code, record.secret);
  if (!valid) {
    throw new AppError("Invalid TOTP code", 401);
  }

  const rawBackupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
    crypto.randomBytes(4).toString("hex"),
  );

  const hashedCodes = await Promise.all(
    rawBackupCodes.map((c) => bcrypt.hash(c, BCRYPT_ROUNDS)),
  );

  await prisma.adminTwoFactor.update({
    where: { userId },
    data: { backupCodes: hashedCodes },
  });

  response.status(200).json({
    backupCodes: rawBackupCodes,
    warning: "Previous backup codes are now invalid. Store these securely.",
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function tryBackupCode(recordId: string, hashedCodes: string[], code: string): Promise<boolean> {
  for (let i = 0; i < hashedCodes.length; i++) {
    const match = await bcrypt.compare(code, hashedCodes[i]);
    if (match) {
      // Remove used backup code
      const updated = [...hashedCodes];
      updated.splice(i, 1);
      await prisma.adminTwoFactor.update({
        where: { id: recordId },
        data: { backupCodes: updated },
      });
      return true;
    }
  }
  return false;
}
