import { UserRole } from "@prisma/client";
import type { Request } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notificationsService } from "../notifications/notifications.service";

/**
 * ONE suspension service for users and vendors (handbook 4.3 / 14.5 / 14.7).
 *
 * Rules enforced here (never only in the UI):
 *  - suspend AND unsuspend both need a reason (>= 5 chars);
 *  - suspend may carry evidence text, an optional end date and a notify toggle;
 *  - anonymised accounts can be neither suspended nor "restored" (409) — the
 *    account has been scrubbed and must never be reactivated;
 *  - every change is audited with the request, the reason and real
 *    before/after state, and the affected person is told (in-app + email)
 *    unless the admin switched notification off;
 *  - a user suspension cascades to that user's store; a store suspension
 *    revokes the owner's sessions. Unsuspend re-enables ONLY the products the
 *    suspension itself switched off (Vendor.suspensionDisabledProductIds).
 */

export const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_LENGTH = 2000;
const MAX_DURATION_DAYS = 730;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SuspendInput {
  reason: string;
  evidence: string | null;
  suspendedUntil: Date | null;
  notifyUser: boolean;
}

export interface UnsuspendInput {
  reason: string;
  notifyUser: boolean;
}

export function requireReason(value: unknown, field = "reason"): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < MIN_REASON_LENGTH) {
    throw new AppError(`A ${field} of at least ${MIN_REASON_LENGTH} characters is required`, 400);
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new AppError(`The ${field} must be at most ${MAX_REASON_LENGTH} characters`, 400);
  }
  return reason;
}

function parseNotify(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "boolean") throw new AppError("notifyUser must be a boolean", 400);
  return value;
}

export function parseSuspendInput(body: unknown, now: Date = new Date()): SuspendInput {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = requireReason(raw.reason);

  let evidence: string | null = null;
  if (raw.evidence !== undefined && raw.evidence !== null && raw.evidence !== "") {
    if (typeof raw.evidence !== "string") throw new AppError("evidence must be text", 400);
    evidence = raw.evidence.trim() || null;
    if (evidence && evidence.length > MAX_EVIDENCE_LENGTH) {
      throw new AppError(`evidence must be at most ${MAX_EVIDENCE_LENGTH} characters`, 400);
    }
  }

  let suspendedUntil: Date | null = null;
  if (raw.durationDays !== undefined && raw.durationDays !== null && raw.durationDays !== "") {
    const days = Number(raw.durationDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DURATION_DAYS) {
      throw new AppError(`durationDays must be a whole number between 1 and ${MAX_DURATION_DAYS}`, 400);
    }
    suspendedUntil = new Date(now.getTime() + days * DAY_MS);
  } else if (raw.suspendedUntil !== undefined && raw.suspendedUntil !== null && raw.suspendedUntil !== "") {
    const until = new Date(String(raw.suspendedUntil));
    if (Number.isNaN(until.getTime())) throw new AppError("suspendedUntil must be a valid date", 400);
    if (until.getTime() <= now.getTime()) throw new AppError("suspendedUntil must be in the future", 400);
    if (until.getTime() > now.getTime() + MAX_DURATION_DAYS * DAY_MS) {
      throw new AppError(`suspendedUntil cannot be more than ${MAX_DURATION_DAYS} days away`, 400);
    }
    suspendedUntil = until;
  }

  return { reason, evidence, suspendedUntil, notifyUser: parseNotify(raw.notifyUser) };
}

export function parseUnsuspendInput(body: unknown): UnsuspendInput {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return { reason: requireReason(raw.reason), notifyUser: parseNotify(raw.notifyUser) };
}

export function isAnonymisedUser(user: { anonymisedAt?: Date | null; email?: string | null }): boolean {
  return Boolean(user.anonymisedAt) || /@anonymized\.local$/i.test(user.email ?? "");
}

// ─── Notification (in-app + email) ──────────────────────────────────────────

const APPEAL_LINE =
  "If you believe this is a mistake, reply to this message or contact Eki support from the app and we will review it.";

async function notifyAccountChange(params: {
  userId: string;
  email: string;
  kind: "suspended" | "restored";
  scope: "account" | "store";
  reason: string;
  until?: Date | null;
}): Promise<boolean> {
  const { userId, email, kind, scope, reason, until } = params;
  const subject =
    kind === "suspended"
      ? scope === "store" ? "Your Eki store has been suspended" : "Your Eki account has been suspended"
      : scope === "store" ? "Your Eki store has been restored" : "Your Eki account has been restored";
  const lines =
    kind === "suspended"
      ? [
          `Reason: ${reason}`,
          until ? `This suspension is scheduled to end on ${until.toUTCString()}.` : "This suspension has no end date set.",
          APPEAL_LINE,
        ]
      : [`Your ${scope} is active again. Note from the Eki team: ${reason}`];
  const body = lines.join("\n\n");

  let delivered = false;
  try {
    await notificationsService.enqueue({
      userId,
      type: "ADMIN_BROADCAST",
      title: subject,
      body,
      data: { event: kind === "suspended" ? "account_suspended" : "account_restored", scope },
    });
    delivered = true;
  } catch (error) {
    logger.warn("Suspension in-app notification failed", {
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  if (email && !/@anonymized\.local$/i.test(email)) {
    try {
      const template = emailTemplates.adminBroadcast({ subject, body });
      await enqueueEmail({ to: email, subject: template.subject, html: template.html });
      delivered = true;
    } catch (error) {
      logger.warn("Suspension email failed", {
        userId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return delivered;
}

function suspensionSnapshot(row: {
  isSuspended: boolean;
  suspendedReason?: string | null;
  suspendedAt?: Date | null;
  suspendedUntil?: Date | null;
  suspensionEvidence?: string | null;
}): Record<string, unknown> {
  return {
    isSuspended: row.isSuspended,
    suspendedReason: row.suspendedReason ?? null,
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
    suspendedUntil: row.suspendedUntil ? row.suspendedUntil.toISOString() : null,
    suspensionEvidence: row.suspensionEvidence ?? null,
  };
}

const CLEARED = {
  isSuspended: false,
  suspendedReason: null,
  suspendedAt: null,
  suspendedById: null,
  suspendedUntil: null,
  suspensionEvidence: null,
} as const;

export const adminSuspensionService = {
  async suspendUser(params: { adminId: string; userId: string; input: SuspendInput; request?: Request }) {
    const { adminId, userId, input, request } = params;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendor: { select: { id: true, isSuspended: true } } },
    });
    if (!user) throw new AppError("User not found", 404);
    if (user.role === UserRole.ADMIN) throw new AppError("Admin accounts cannot be suspended here", 409);
    if (isAnonymisedUser(user)) throw new AppError("This account has been anonymised and cannot be suspended", 409);
    if (user.isSuspended) throw new AppError("User is already suspended", 409);

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          isSuspended: true,
          suspendedReason: input.reason,
          suspendedAt: now,
          suspendedById: adminId,
          suspendedUntil: input.suspendedUntil,
          suspensionEvidence: input.evidence,
          tokenVersion: { increment: 1 },
        },
      });

      let cascadedVendorId: string | null = null;
      let disabledProductCount = 0;
      if (user.vendor && !user.vendor.isSuspended) {
        const active = await tx.product.findMany({
          where: { vendorId: user.vendor.id, isActive: true },
          select: { id: true },
        });
        const ids = active.map((p) => p.id);
        if (ids.length > 0) {
          await tx.product.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
        }
        await tx.vendor.update({
          where: { id: user.vendor.id },
          data: {
            isSuspended: true,
            suspendedReason: input.reason,
            suspendedAt: now,
            suspendedById: adminId,
            suspendedUntil: input.suspendedUntil,
            suspensionEvidence: input.evidence,
            suspensionDisabledProductIds: ids,
          },
        });
        cascadedVendorId = user.vendor.id;
        disabledProductCount = ids.length;
      }
      return { updated, cascadedVendorId, disabledProductCount };
    });

    await recordAudit({
      actorId: adminId,
      action: "user.suspend",
      entityType: "User",
      entityId: userId,
      reason: input.reason,
      metadata: { role: user.role, notifyUser: input.notifyUser },
      beforeState: suspensionSnapshot(user),
      afterState: {
        ...suspensionSnapshot(result.updated),
        cascadedVendorId: result.cascadedVendorId,
        disabledProductCount: result.disabledProductCount,
      },
      request,
    });

    const notified = input.notifyUser
      ? await notifyAccountChange({
          userId,
          email: user.email,
          kind: "suspended",
          scope: "account",
          reason: input.reason,
          until: input.suspendedUntil,
        })
      : false;

    return { user: result.updated, notified };
  },

  async unsuspendUser(params: {
    adminId: string;
    userId: string;
    input: UnsuspendInput;
    request?: Request;
    auditAction?: string;
  }) {
    const { adminId, userId, input, request } = params;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        vendor: {
          select: { id: true, isSuspended: true, suspendedAt: true, closedAt: true, suspensionDisabledProductIds: true },
        },
      },
    });
    if (!user) throw new AppError("User not found", 404);
    if (isAnonymisedUser(user)) {
      throw new AppError("This account has been anonymised and cannot be restored", 409);
    }
    if (!user.isSuspended) throw new AppError("User is not suspended", 409);

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { ...CLEARED, tokenVersion: { increment: 1 } },
      });

      // Only a store suspension that CAME FROM this user suspension (same
      // timestamp, or a legacy row with none) is lifted with it. A store that
      // was separately suspended for its own reasons stays suspended.
      let restoredVendorId: string | null = null;
      let restoredProductCount = 0;
      const vendor = user.vendor;
      const sameEvent =
        vendor?.isSuspended &&
        !vendor.closedAt &&
        (vendor.suspendedAt?.getTime() ?? null) === (user.suspendedAt?.getTime() ?? null);
      if (vendor && sameEvent) {
        const ids = vendor.suspensionDisabledProductIds ?? [];
        if (ids.length > 0) {
          const r = await tx.product.updateMany({ where: { id: { in: ids }, vendorId: vendor.id }, data: { isActive: true } });
          restoredProductCount = r.count;
        }
        await tx.vendor.update({
          where: { id: vendor.id },
          data: { ...CLEARED, suspensionDisabledProductIds: [] },
        });
        restoredVendorId = vendor.id;
      }
      return { updated, restoredVendorId, restoredProductCount };
    });

    await recordAudit({
      actorId: adminId,
      action: params.auditAction ?? "user.unsuspend",
      entityType: "User",
      entityId: userId,
      reason: input.reason,
      metadata: { role: user.role, notifyUser: input.notifyUser },
      beforeState: suspensionSnapshot(user),
      afterState: {
        ...suspensionSnapshot(result.updated),
        restoredVendorId: result.restoredVendorId,
        restoredProductCount: result.restoredProductCount,
      },
      request,
    });

    const notified = input.notifyUser
      ? await notifyAccountChange({
          userId,
          email: user.email,
          kind: "restored",
          scope: "account",
          reason: input.reason,
        })
      : false;

    return { user: result.updated, notified };
  },

  async suspendVendor(params: { adminId: string; vendorId: string; input: SuspendInput; request?: Request }) {
    const { adminId, vendorId, input, request } = params;
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: { user: { select: { id: true, email: true, anonymisedAt: true } } },
    });
    if (!vendor) throw new AppError("Vendor not found", 404);
    if (vendor.closedAt) throw new AppError("This vendor has been closed and cannot be suspended", 409);
    if (vendor.isSuspended) throw new AppError("Vendor is already suspended", 409);

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const active = await tx.product.findMany({ where: { vendorId, isActive: true }, select: { id: true } });
      const ids = active.map((p) => p.id);
      if (ids.length > 0) {
        await tx.product.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
      }
      const updated = await tx.vendor.update({
        where: { id: vendorId },
        data: {
          isSuspended: true,
          suspendedReason: input.reason,
          suspendedAt: now,
          suspendedById: adminId,
          suspendedUntil: input.suspendedUntil,
          suspensionEvidence: input.evidence,
          suspensionDisabledProductIds: ids,
        },
      });
      // Revoke the owner's sessions so the store dashboard stops working now.
      await tx.user.update({ where: { id: vendor.userId }, data: { tokenVersion: { increment: 1 } } });
      return { updated, disabledProductCount: ids.length };
    });

    await recordAudit({
      actorId: adminId,
      action: "vendor.suspend",
      entityType: "Vendor",
      entityId: vendorId,
      reason: input.reason,
      metadata: { ownerUserId: vendor.userId, notifyUser: input.notifyUser },
      beforeState: suspensionSnapshot(vendor),
      afterState: { ...suspensionSnapshot(result.updated), disabledProductCount: result.disabledProductCount },
      request,
    });

    const notified = input.notifyUser
      ? await notifyAccountChange({
          userId: vendor.userId,
          email: vendor.user.email,
          kind: "suspended",
          scope: "store",
          reason: input.reason,
          until: input.suspendedUntil,
        })
      : false;

    return { vendor: result.updated, notified };
  },

  async unsuspendVendor(params: {
    adminId: string;
    vendorId: string;
    input: UnsuspendInput;
    request?: Request;
    auditAction?: string;
  }) {
    const { adminId, vendorId, input, request } = params;
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: { user: { select: { id: true, email: true, isSuspended: true, anonymisedAt: true } } },
    });
    if (!vendor) throw new AppError("Vendor not found", 404);
    if (vendor.closedAt) throw new AppError("This vendor has been closed and cannot be restored", 409);
    if (isAnonymisedUser(vendor.user)) {
      throw new AppError("The owner account has been anonymised; this vendor cannot be restored", 409);
    }
    if (!vendor.isSuspended) throw new AppError("Vendor is not suspended", 409);
    if (vendor.user.isSuspended) {
      throw new AppError("The owner's user account is suspended; restore the user account instead", 409);
    }

    const result = await prisma.$transaction(async (tx) => {
      const ids = vendor.suspensionDisabledProductIds ?? [];
      let restoredProductCount = 0;
      if (ids.length > 0) {
        const r = await tx.product.updateMany({ where: { id: { in: ids }, vendorId }, data: { isActive: true } });
        restoredProductCount = r.count;
      }
      const updated = await tx.vendor.update({
        where: { id: vendorId },
        data: { ...CLEARED, suspensionDisabledProductIds: [] },
      });
      return { updated, restoredProductCount };
    });

    await recordAudit({
      actorId: adminId,
      action: params.auditAction ?? "vendor.unsuspend",
      entityType: "Vendor",
      entityId: vendorId,
      reason: input.reason,
      metadata: { ownerUserId: vendor.userId, notifyUser: input.notifyUser },
      beforeState: suspensionSnapshot(vendor),
      afterState: { ...suspensionSnapshot(result.updated), restoredProductCount: result.restoredProductCount },
      request,
    });

    const notified = input.notifyUser
      ? await notifyAccountChange({
          userId: vendor.userId,
          email: vendor.user.email,
          kind: "restored",
          scope: "store",
          reason: input.reason,
        })
      : false;

    return { vendor: result.updated, notified };
  },

  /**
   * Bulk suspend: same rules per vendor, one audit row each. A vendor that
   * cannot be suspended (closed / already suspended) is reported, not fatal.
   */
  async bulkSuspendVendors(params: { adminId: string; vendorIds: string[]; input: SuspendInput; request?: Request }) {
    const results: Array<{ vendorId: string; ok: boolean; error?: string }> = [];
    for (const vendorId of [...new Set(params.vendorIds)].slice(0, 100)) {
      try {
        await this.suspendVendor({ adminId: params.adminId, vendorId, input: params.input, request: params.request });
        results.push({ vendorId, ok: true });
      } catch (error) {
        results.push({ vendorId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { affected: results.filter((r) => r.ok).length, results };
  },

  /**
   * Lifts timed suspensions whose end date has passed. Run from the daily
   * sweep, so an expiry can lag by up to a day — the UI says so.
   */
  async liftExpired(now: Date = new Date()) {
    const input: UnsuspendInput = { reason: "Suspension period ended automatically", notifyUser: true };
    let users = 0;
    let vendors = 0;

    const dueUsers = await prisma.user.findMany({
      where: { isSuspended: true, suspendedUntil: { lte: now }, anonymisedAt: null },
      select: { id: true, suspendedById: true },
      take: 200,
    });
    for (const u of dueUsers) {
      try {
        await this.unsuspendUser({ adminId: u.suspendedById ?? "system", userId: u.id, input, auditAction: "user.unsuspend.auto" });
        users++;
      } catch (error) {
        logger.warn("Auto-unsuspend (user) skipped", { userId: u.id, errorMessage: String(error) });
      }
    }

    const dueVendors = await prisma.vendor.findMany({
      where: { isSuspended: true, suspendedUntil: { lte: now }, closedAt: null },
      select: { id: true, suspendedById: true },
      take: 200,
    });
    for (const v of dueVendors) {
      try {
        await this.unsuspendVendor({ adminId: v.suspendedById ?? "system", vendorId: v.id, input, auditAction: "vendor.unsuspend.auto" });
        vendors++;
      } catch (error) {
        logger.warn("Auto-unsuspend (vendor) skipped", { vendorId: v.id, errorMessage: String(error) });
      }
    }
    return { users, vendors };
  },
};
