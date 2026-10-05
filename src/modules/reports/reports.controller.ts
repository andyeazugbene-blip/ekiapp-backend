import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import * as reportsService from "./reports.service";

const VALID_TARGET_TYPES = ["review", "message", "product", "store"] as const;
const VALID_REASONS = ["inappropriate", "spam", "harassment", "fraud", "other"] as const;

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function submitReport(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);

  const { targetType, targetId, reason, details } = request.body;
  if (!targetType || !targetId || !reason) {
    throw new AppError("targetType, targetId, and reason are required", 400);
  }

  if (!VALID_TARGET_TYPES.includes(targetType)) {
    throw new AppError(`targetType must be one of: ${VALID_TARGET_TYPES.join(", ")}`, 400);
  }

  if (!VALID_REASONS.includes(reason)) {
    throw new AppError(`reason must be one of: ${VALID_REASONS.join(", ")}`, 400);
  }

  const report = await reportsService.createReport({
    reporterId: userId,
    targetType,
    targetId,
    reason,
    details: details?.slice(0, 500),
  });
  response.status(201).json({ report });
}

export async function blockUserHandler(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);

  const { blockedId } = request.body;
  if (!blockedId) throw new AppError("blockedId is required", 400);

  const block = await reportsService.blockUser(userId, blockedId);
  response.status(201).json({ block });
}

export async function unblockUserHandler(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);

  const blockedId = String(request.params.blockedId ?? "");
  if (!blockedId) throw new AppError("blockedId is required", 400);
  await reportsService.unblockUser(userId, blockedId);
  response.json({ success: true });
}

export async function listBlockedUsers(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);

  const blocked = await reportsService.getBlockedUsers(userId);
  response.json({ blocked });
}

// Admin
export async function adminListReports(request: Request, response: Response): Promise<void> {
  const status = typeof request.query.status === "string" && request.query.status ? request.query.status : undefined;
  const cursor = typeof request.query.cursor === "string" && request.query.cursor ? request.query.cursor : undefined;
  const targetType = typeof request.query.targetType === "string" && request.query.targetType ? request.query.targetType : undefined;
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  const result = await reportsService.listReports(status, { cursor, targetType, limit: Number.isFinite(limit) ? limit : undefined });
  response.json(result);
}

export async function adminReviewReport(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const id = String(request.params.id ?? "");
  if (!id) throw new AppError("Report id is required", 400);
  const { status, reason } = request.body ?? {};

  if (!["REVIEWED", "DISMISSED"].includes(status)) {
    throw new AppError("status must be REVIEWED or DISMISSED", 400);
  }
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length < 5) throw new AppError("A reason of at least 5 characters is required", 400);

  const existing = await prisma.contentReport.findUnique({ where: { id } });
  if (!existing) throw new AppError("Report not found", 404);
  const report = await reportsService.reviewReport(id, status, userId, trimmed);

  await recordAudit({
    actorId: userId,
    action: "report.reviewed",
    entityType: "ContentReport",
    entityId: id,
    reason: trimmed,
    beforeState: { status: existing.status },
    afterState: { status },
    metadata: { status, targetType: existing.targetType, targetId: existing.targetId },
    request,
  });

  response.json({ report });
}
