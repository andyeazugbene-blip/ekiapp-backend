import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
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
        metadata: entry.metadata
          ? (entry.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
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
