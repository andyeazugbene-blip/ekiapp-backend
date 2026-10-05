import type { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export interface AuditLogFilters {
  actorId?: string;
  actorQuery?: string; // name or email contains
  action?: string; // contains, case-insensitive
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  reasonQuery?: string;
}

export const AUDIT_EXPORT_MAX_ROWS = 5000;

function parseDate(raw: unknown, endOfDay: boolean): Date | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : raw);
  if (Number.isNaN(d.getTime())) throw new AppError(`Invalid date: ${raw}`, 400);
  return d;
}

export function parseAuditFilters(query: Record<string, unknown>): AuditLogFilters {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const filters: AuditLogFilters = {
    actorId: str(query.actorId),
    actorQuery: str(query.actor),
    action: str(query.action),
    entityType: str(query.entityType),
    entityId: str(query.entityId),
    from: parseDate(query.from, false),
    to: parseDate(query.to, true),
    reasonQuery: str(query.q),
  };
  if (filters.from && filters.to && filters.from > filters.to) throw new AppError("from must be before to", 400);
  return filters;
}

async function buildWhere(f: AuditLogFilters): Promise<Prisma.AuditLogWhereInput> {
  const where: Prisma.AuditLogWhereInput = {};
  if (f.actorId) where.actorId = f.actorId;
  if (f.actorQuery) {
    const users = await prisma.user.findMany({
      where: { OR: [{ name: { contains: f.actorQuery, mode: "insensitive" } }, { email: { contains: f.actorQuery, mode: "insensitive" } }] },
      select: { id: true },
      take: 200,
    });
    where.actorId = f.actorId ? f.actorId : { in: users.map((u) => u.id) };
  }
  if (f.action) where.action = { contains: f.action, mode: "insensitive" };
  if (f.entityType) where.entityType = f.entityType;
  if (f.entityId) where.entityId = f.entityId;
  if (f.reasonQuery) where.reason = { contains: f.reasonQuery, mode: "insensitive" };
  if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) };
  return where;
}

async function withActors<T extends { actorId: string }>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.actorId).filter(Boolean))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, role: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({ ...r, actor: byId.get(r.actorId) ?? null }));
}

export const adminAuditLogsService = {
  async list(filters: AuditLogFilters, limit: number, cursor?: string) {
    const where = await buildWhere(filters);
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (rows.length > limit) nextCursor = rows.pop()?.id ?? null;
    return { items: await withActors(rows), nextCursor };
  },

  /** Distinct entity types and action prefixes, for filter dropdowns. */
  async facets() {
    const types = await prisma.auditLog.groupBy({ by: ["entityType"], _count: { _all: true }, orderBy: { entityType: "asc" }, take: 200 });
    return { entityTypes: types.map((t) => t.entityType) };
  },

  async exportRows(filters: AuditLogFilters) {
    const where = await buildWhere(filters);
    const rows = await prisma.auditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: AUDIT_EXPORT_MAX_ROWS });
    return withActors(rows);
  },
};

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : value instanceof Date ? value.toISOString() : JSON.stringify(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditRowsToCsv(rows: Awaited<ReturnType<typeof adminAuditLogsService.exportRows>>): string {
  const header = ["Time (UTC)", "Actor name", "Actor email", "Actor ID", "Action", "Entity type", "Entity ID", "Reason", "Permission", "IP", "Before", "After", "Metadata"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.createdAt, r.actor?.name, r.actor?.email, r.actorId, r.action, r.entityType, r.entityId, r.reason, r.permissionUsed, r.ipAddress, r.beforeState, r.afterState, r.metadata]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}
