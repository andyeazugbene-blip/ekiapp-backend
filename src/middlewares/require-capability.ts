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
 *
 * Deliberately strict (APPROVED only) — this gates taking on brand-new
 * work (accepting/declining an invitation, negotiating a proposal), and
 * pause/restriction existing precisely to stop a supplier from taking on
 * more of that. Continuing an ALREADY-accepted campaign's fulfilment or
 * viewing its payment goes through requireApprovedSupplierForOwnCampaign
 * below instead — see that function's own comment for why the two must
 * not share one gate.
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

// Figma S31/S32 correction — "pause only blocks NEW invitations... do not
// silently suspend existing campaign obligations," matching this app's own
// UI copy ("existing campaigns stay unaffected"). PAUSED/RESTRICTED are
// exactly the two states community-buy-supplier.tsx's own
// DASHBOARD_VISIBLE_STATES already treats as "still has real obligations to
// see" — SUSPENDED/CLOSED are not included; those genuinely cut a supplier
// off (see supplier-account.service.ts's suspend()).
const FULFILMENT_CONTINUATION_STATES: ReadonlyArray<string> = ["APPROVED", "PAUSED", "RESTRICTED"];

/**
 * Same intent as requireApprovedSupplier(), for the narrower set of routes
 * that only ever act on a campaign this supplier is ALREADY assigned to
 * (fulfilment progression, payment/payout reads) — never a route that
 * creates a new obligation. A PAUSED/RESTRICTED supplier is let through
 * only when the campaign in the URL is genuinely theirs; anyone else still
 * gets the same 403 requireApprovedSupplier() would give.
 */
export function requireApprovedSupplierForOwnCampaign() {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.user) throw new AppError("Unauthorized", 401);
      const account = await prisma.supplierAccount.findUnique({
        where: { userId: request.user.id },
        select: { id: true, supplierState: true },
      });
      if (!account || !FULFILMENT_CONTINUATION_STATES.includes(account.supplierState)) {
        throw new AppError("You must be an approved Community Buy supplier to do this.", 403);
      }
      // A route with no :id (e.g. "list my own campaigns") is already
      // self-scoped to this account by the service it calls — nothing
      // further to check here. A route with :id must be about a campaign
      // genuinely assigned to this account, not an arbitrary one.
      const campaignId = typeof request.params.id === "string" ? request.params.id : undefined;
      if (account.supplierState !== "APPROVED" && campaignId) {
        const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, select: { supplierAccountId: true } });
        if (!campaign || campaign.supplierAccountId !== account.id) {
          throw new AppError("You must be an approved Community Buy supplier to do this.", 403);
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
