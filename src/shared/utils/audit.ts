import { Prisma } from "@prisma/client";
import type { Request } from "express";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../errors/app-error";

export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  // Architecture-mandated fields (audit completeness gap closure). All
  // optional/nullable: only populated where the calling code genuinely
  // has the information. permissionUsed and ipAddress are filled
  // automatically from `request` when one is passed, so most call sites
  // get them for free just by adding `request` — no other change needed.
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  reason?: string;
  request?: Request;
  /**
   * Handbook §13/§14.12: money, role and settings mutations must not
   * succeed without an audit record. When true, a failed audit write is
   * re-thrown (after being logged) so the caller's request fails instead of
   * silently completing unaudited. Default false keeps the historical
   * "never break the request path" behaviour for low-risk call sites.
   */
  failClosed?: boolean;
}

export const MIN_AUDIT_REASON_LENGTH = 5;
export const MAX_AUDIT_REASON_LENGTH = 1000;

/**
 * Server-side validation of an admin-supplied reason (handbook §14.12).
 * Returns the trimmed reason or throws a 400 with code REASON_REQUIRED.
 */
export function requireAuditReason(raw: unknown, label = "reason"): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < MIN_AUDIT_REASON_LENGTH) {
    throw new AppError(
      `A ${label} of at least ${MIN_AUDIT_REASON_LENGTH} characters is required for this action`,
      400,
      null,
      "REASON_REQUIRED",
    );
  }
  if (reason.length > MAX_AUDIT_REASON_LENGTH) {
    throw new AppError(`${label} is too long (max ${MAX_AUDIT_REASON_LENGTH} characters)`, 400, null, "REASON_TOO_LONG");
  }
  return reason;
}

function toJson(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value ? (value as Prisma.InputJsonValue) : Prisma.JsonNull;
}

/**
 * Record an admin action in the audit log.
 * Never throws by default — audit failures must not break the request path.
 * Pass `failClosed: true` for money/role/settings mutations: the write error
 * is then re-thrown as a 500 AUDIT_WRITE_FAILED.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: toJson(entry.metadata),
        beforeState: toJson(entry.beforeState),
        afterState: toJson(entry.afterState),
        reason: entry.reason ?? null,
        permissionUsed: entry.request?.usedPermission ?? null,
        ipAddress: entry.request?.ip ?? null,
      },
    });
  } catch (error) {
    logger.error("Audit log write failed", {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      failClosed: entry.failClosed === true,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    if (entry.failClosed) {
      throw new AppError(
        "The action could not be recorded in the audit log, so it was not completed.",
        500,
        null,
        "AUDIT_WRITE_FAILED",
      );
    }
  }
}
