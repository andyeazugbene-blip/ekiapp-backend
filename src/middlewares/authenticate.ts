import { prisma } from "../lib/prisma";
import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@prisma/client";

import { AppError } from "../shared/errors/app-error";
import { authService } from "../modules/auth/auth.service";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: UserRole;
        email: string;
      };
      // Set by requireAdminPermission — lets recordAudit() capture which
      // permission actually gated a mutation, without every call site
      // having to pass it explicitly.
      usedPermission?: string;
    }
  }
}

// Handbook 14.5 L167: admin needs a real "last active". Written at most once
// per 10 minutes per user per instance, fire-and-forget (never blocks or fails
// a request).
const LAST_ACTIVE_THROTTLE_MS = 10 * 60 * 1000;
const lastActiveTouched = new Map<string, number>();
function touchLastActive(userId: string): void {
  const now = Date.now();
  const prev = lastActiveTouched.get(userId) ?? 0;
  if (now - prev < LAST_ACTIVE_THROTTLE_MS) return;
  lastActiveTouched.set(userId, now);
  if (lastActiveTouched.size > 5000) lastActiveTouched.clear();
  void prisma.user
    .updateMany({
      where: { id: userId, OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: new Date(now - LAST_ACTIVE_THROTTLE_MS) } }] },
      data: { lastActiveAt: new Date(now) },
    })
    .catch(() => undefined);
}

export function authenticate(request: Request, _response: Response, next: NextFunction): void {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    next(new AppError("Missing or invalid Authorization header", 401));
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    next(new AppError("Missing token", 401));
    return;
  }

  let payload;
  try {
    payload = authService.verifyToken(token);
  } catch (error) {
    next(error);
    return;
  }

  // Verify tokenVersion against DB (async) and load live role
  authService
    .verifyTokenVersion(payload.sub, payload.tv ?? 0)
    .then((result) => {
      if (!result.valid) {
        next(new AppError("Token revoked. Please log in again.", 401));
        return;
      }
      if (result.suspended) {
        next(new AppError("Your account has been suspended. Contact support.", 423));
        return;
      }
      // Use DB role (not JWT claim) so role changes take effect immediately
      request.user = { id: payload.sub, role: result.role ?? payload.role, email: payload.email };
      touchLastActive(payload.sub);
      next();
    })
    .catch((error) => {
      next(error);
    });
}

export function requireRole(...roles: UserRole[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.user) {
      next(new AppError("Unauthorized", 401));
      return;
    }
    if (!roles.includes(request.user.role)) {
      next(new AppError("Forbidden", 403));
      return;
    }
    next();
  };
}

/**
 * Optional authentication — attaches user if a valid token is present,
 * but does NOT reject the request if no token is provided.
 */
export function optionalAuthenticate(request: Request, _response: Response, next: NextFunction): void {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    next();
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    next();
    return;
  }

  let payload;
  try {
    payload = authService.verifyToken(token);
  } catch {
    // Invalid token — proceed without user context
    next();
    return;
  }

  authService
    .verifyTokenVersion(payload.sub, payload.tv ?? 0)
    .then((result) => {
      if (result.valid && !result.suspended) {
        request.user = { id: payload.sub, role: result.role ?? payload.role, email: payload.email };
      }
      next();
    })
    .catch(() => {
      next();
    });
}
