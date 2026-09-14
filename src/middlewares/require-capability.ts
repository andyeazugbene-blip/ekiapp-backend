import type { NextFunction, Request, Response } from "express";

import { AppError } from "../shared/errors/app-error";
import { prisma } from "../lib/prisma";

/**
 * Community Buy Workstream 1 — capability-based guards replacing
 * requireRole("VENDOR"/"VENDOR","ADMIN") without changing the original
 * authorization matrix. A Vendor row exists independently of User.role
 * now that opening a store no longer flips role to VENDOR (see
 * vendors.service.ts createVendor) — these guards check that row
 * directly instead of the (no longer reliable) role column.
 *
 * requireVendorProfile: exact replacement for requireRole("VENDOR") —
 * no admin bypass, since role is single-valued and an ADMIN could never
 * simultaneously satisfy requireRole("VENDOR") either.
 */
export function requireVendorProfile() {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.user) throw new AppError("Unauthorized", 401);
      const vendor = await prisma.vendor.findUnique({ where: { userId: request.user.id }, select: { id: true } });
      if (!vendor) throw new AppError("Vendor profile required", 403);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Exact replacement for requireRole("VENDOR", "ADMIN"). */
export function requireVendorProfileOrAdmin() {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.user) throw new AppError("Unauthorized", 401);
      if (request.user.role === "ADMIN") {
        next();
        return;
      }
      const vendor = await prisma.vendor.findUnique({ where: { userId: request.user.id }, select: { id: true } });
      if (!vendor) throw new AppError("Vendor profile required", 403);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Gates protected Community Buy supplier ACTIONS only (accepting
 * obligations, fulfilment, payment views) — never the Supplier Centre
 * landing/apply routes, which must stay open to any authenticated user
 * (spec AT-03: opening Supplier Centre without approval shows a setup
 * state, not an authorization error).
 */
export function requireApprovedSupplier() {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.user) throw new AppError("Unauthorized", 401);
      const account = await prisma.supplierAccount.findUnique({
        where: { userId: request.user.id },
        select: { supplierState: true },
      });
      if (!account || account.supplierState !== "APPROVED") {
        throw new AppError("You must be an approved Community Buy supplier to do this.", 403);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
