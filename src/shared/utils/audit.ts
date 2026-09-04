import { Prisma } from "@prisma/client";
import type { Request } from "express";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

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
}

function toJson(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value ? (value as Prisma.InputJsonValue) : Prisma.JsonNull;
}

/**
 * Record an admin action in the audit log.
 * Never throws — audit failures must not break the request path.
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
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
