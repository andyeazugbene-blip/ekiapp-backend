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
    }
  }
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

  // Verify tokenVersion against DB (async)
  authService
    .verifyTokenVersion(payload.sub, payload.tv ?? 0)
    .then((valid) => {
      if (!valid) {
        next(new AppError("Token revoked. Please log in again.", 401));
        return;
      }
      request.user = { id: payload.sub, role: payload.role, email: payload.email };
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
