import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { adminDashboardService } from "./admin-dashboard.service";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export async function getAdminDashboard(_request: Request, response: Response): Promise<void> {
  const data = await adminDashboardService.getDashboard();
  response.status(200).json(data);
}

export async function getAdminAnalytics(_request: Request, response: Response): Promise<void> {
  const data = await adminDashboardService.getAnalytics();
  response.status(200).json(data);
}

export async function listAuditLogs(request: Request, response: Response): Promise<void> {
  const query = request.query as Record<string, unknown>;

  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }

  const result = await adminDashboardService.listAuditLogs({
    actorId: typeof query.actorId === "string" && query.actorId.length > 0 ? query.actorId : undefined,
    action: typeof query.action === "string" && query.action.length > 0 ? query.action : undefined,
    entityType: typeof query.entityType === "string" && query.entityType.length > 0 ? query.entityType : undefined,
    limit,
    cursor: typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined,
  });

  response.status(200).json(result);
}
