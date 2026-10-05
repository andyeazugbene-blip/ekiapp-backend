import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminAuditLogsService, auditRowsToCsv, parseAuditFilters, AUDIT_EXPORT_MAX_ROWS } from "./admin-audit-logs.service";

const MAX_LIMIT = 100;

export async function listAuditLogsV2(request: Request, response: Response): Promise<void> {
  const query = request.query as Record<string, unknown>;
  let limit = 25;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    limit = parsed;
  }
  const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : undefined;
  const result = await adminAuditLogsService.list(parseAuditFilters(query), limit, cursor);
  response.json(result);
}

export async function getAuditLogFacets(_request: Request, response: Response): Promise<void> {
  response.json(await adminAuditLogsService.facets());
}

export async function exportAuditLogs(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const filters = parseAuditFilters(request.query as Record<string, unknown>);
  const rows = await adminAuditLogsService.exportRows(filters);
  await recordAudit({
    actorId: request.user.id,
    action: "audit.export",
    entityType: "AuditLog",
    metadata: { rows: rows.length, truncated: rows.length >= AUDIT_EXPORT_MAX_ROWS, filters },
    request,
    failClosed: true,
  });
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  response.status(200).send("\uFEFF" + auditRowsToCsv(rows));
}
