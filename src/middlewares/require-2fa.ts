import type { NextFunction, Request, Response } from "express";

import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

import { prisma } from "../lib/prisma";
import { AppError } from "../shared/errors/app-error";

/**
 * Middleware that enforces 2FA on sensitive admin routes.
 * If the admin has 2FA enabled, they must provide a valid TOTP code
 * (or backup code) in the `x-2fa-code` header.
 *
 * If 2FA is not enabled for the admin, the request passes through.
 */
export async function require2fa(request: Request, _response: Response, next: NextFunction): Promise<void> {
  if (!request.user) {
    next(new AppError("Unauthorized", 401));
    return;
  }

  let record: Awaited<ReturnType<typeof prisma.adminTwoFactor.findUnique>> | null = null;
  try {
    record = await prisma.adminTwoFactor.findUnique({
      where: { userId: request.user.id },
    });
  } catch {
    // Table may not exist yet (migration not deployed). Treat as 2FA not set up.
    next();
    return;
  }

  // If 2FA not set up or not enabled, allow through
  if (!record || !record.enabled) {
    next();
    return;
  }

  const code = request.headers["x-2fa-code"] as string | undefined;
  if (!code) {
    next(new AppError("2FA code required in x-2fa-code header", 403, null, "2FA_REQUIRED"));
    return;
  }

  // Try TOTP
  const totpValid = authenticator.check(code, record.secret);
  if (totpValid) {
    next();
    return;
  }

  // Try backup code
  for (let i = 0; i < record.backupCodes.length; i++) {
    const match = await bcrypt.compare(code, record.backupCodes[i]);
    if (match) {
      // Consume the backup code
      const updated = [...record.backupCodes];
      updated.splice(i, 1);
      await prisma.adminTwoFactor.update({
        where: { id: record.id },
        data: { backupCodes: updated },
      });
      next();
      return;
    }
  }

  next(new AppError("Invalid 2FA code", 403, null, "2FA_INVALID"));
}
