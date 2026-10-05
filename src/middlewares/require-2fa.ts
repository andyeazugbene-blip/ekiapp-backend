import type { NextFunction, Request, Response } from "express";

import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { AppError } from "../shared/errors/app-error";
import { isAdmin2faEnforced } from "../config/admin-2fa";

/**
 * Middleware that enforces 2FA on sensitive admin routes.
 * If the admin has 2FA enabled, they must provide a valid TOTP code
 * (or backup code) in the `x-2fa-code` header.
 *
 * If 2FA is not enabled for the admin: when ADMIN_2FA_ENFORCE is on (default
 * in production) the request is refused with TWO_FACTOR_SETUP_REQUIRED;
 * otherwise (development/test default) it passes through.
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
  } catch (error) {
    // Only a genuinely-missing table (migration not deployed yet) is safe
    // to treat as "2FA not set up" — any other DB error (a transient
    // connection blip, for example) must fail closed instead of silently
    // waving through a request to a route this gate was meant to protect.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      next();
      return;
    }
    logger.error("2FA check failed — failing closed", { userId: request.user.id, errorMessage: error instanceof Error ? error.message : String(error) });
    next(new AppError("Could not verify 2FA status. Try again.", 503));
    return;
  }

  // 2FA not set up / not enabled: with ADMIN_2FA_ENFORCE (default on in
  // production) the admin must enrol first; otherwise legacy pass-through.
  if (!record || !record.enabled) {
    if (isAdmin2faEnforced()) {
      next(
        new AppError(
          "Two-factor authentication must be set up before you can perform this action.",
          403,
          null,
          "TWO_FACTOR_SETUP_REQUIRED",
        ),
      );
      return;
    }
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
