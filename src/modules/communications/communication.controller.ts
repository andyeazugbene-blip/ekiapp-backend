import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminCommunicationsService } from "../admin/admin-communications.service";
import { communicationService } from "./communication.service";
import { scheduledCommunicationService } from "./scheduled-communication.service";

export async function listCommunicationLogs(request: Request, response: Response): Promise<void> {
  const eventKey = typeof request.query.eventKey === "string" ? request.query.eventKey : undefined;
  const recipientType = typeof request.query.recipientType === "string" ? request.query.recipientType : undefined;
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const broadcastId = typeof request.query.broadcastId === "string" ? request.query.broadcastId : undefined;
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  const offset = request.query.offset ? Number(request.query.offset) : undefined;

  const result = await communicationService.listLogs({ eventKey, recipientType, status, broadcastId, limit, offset });
  response.status(200).json(result);
}

export async function listCommunicationTemplates(_request: Request, response: Response): Promise<void> {
  const templates = await communicationService.getTemplates();
  response.status(200).json({ templates });
}

export async function getCommunicationStats(_request: Request, response: Response): Promise<void> {
  const stats = await communicationService.getStats();
  response.status(200).json(stats);
}

export async function seedCommunicationTemplates(_request: Request, response: Response): Promise<void> {
  const count = await communicationService.seedTemplates();
  response.status(200).json({ seeded: count });
}

export async function updateCommunicationTemplate(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const key = request.params.key as string;
  if (!key) throw new AppError("Template key is required", 400);

  const { title, body, channels, enabled, reason } = request.body as {
    title?: string; body?: string; channels?: string[]; enabled?: boolean; reason?: string;
  };
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason.length < 5) throw new AppError("A reason of at least 5 characters is required to change a template", 400);

  const updated = await communicationService.updateTemplate(
    key,
    { title, body, channels, enabled },
    { id: request.user.id, reason: trimmedReason, request },
  );
  response.status(200).json(updated);
}

export async function listCommunicationTemplateVersions(request: Request, response: Response): Promise<void> {
  const key = request.params.key as string;
  if (!key) throw new AppError("Template key is required", 400);
  response.status(200).json({ versions: await communicationService.getTemplateVersions(key) });
}

// ─── Scheduled Communications ───────────────────────────────────────────────

/** Legacy entry point; the Communications page schedules through POST /admin/broadcasts with scheduledFor. */
export async function createScheduledCommunication(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const input = adminCommunicationsService.normalizeInput(body);
  const scheduledFor = typeof body.scheduledFor === "string" ? body.scheduledFor : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!scheduledFor) throw new AppError("scheduledFor is required", 400);
  adminCommunicationsService.assertTestPassed(request.user.id, input, body.testToken);
  const item = await scheduledCommunicationService.create({ input, reason, scheduledFor, createdBy: request.user.id });
  await recordAudit({
    actorId: request.user.id,
    action: "admin.broadcast.scheduled",
    entityType: "Broadcast",
    entityId: item.broadcastId ?? undefined,
    reason: reason.trim(),
    request,
    afterState: { audience: input.audience, scheduledFor: item.scheduledFor.toISOString(), title: input.subject },
  });
  response.status(201).json(item);
}

export async function listScheduledCommunications(request: Request, response: Response): Promise<void> {
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  const offset = request.query.offset ? Number(request.query.offset) : undefined;
  const result = await scheduledCommunicationService.list({ status, limit, offset });
  response.status(200).json(result);
}

export async function cancelScheduledCommunication(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const id = request.params.id as string;
  if (!id) throw new AppError("ID is required", 400);
  const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
  if (reason.length < 5) throw new AppError("A reason of at least 5 characters is required", 400);
  const item = await scheduledCommunicationService.cancel(id);
  await recordAudit({
    actorId: request.user.id, action: "admin.broadcast.schedule_cancelled", entityType: "Broadcast",
    entityId: item?.broadcastId ?? undefined, reason, request,
  });
  response.status(200).json(item);
}

export async function updateScheduledCommunication(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const id = request.params.id as string;
  if (!id) throw new AppError("ID is required", 400);
  const { subject, body, scheduledFor, reason } = request.body as {
    subject?: string; body?: string; scheduledFor?: string; reason?: string;
  };
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length < 5) throw new AppError("A reason of at least 5 characters is required", 400);
  const item = await scheduledCommunicationService.update(id, { subject, body, scheduledFor });
  await recordAudit({
    actorId: request.user.id, action: "admin.broadcast.schedule_updated", entityType: "Broadcast",
    entityId: item?.broadcastId ?? undefined, reason: trimmed, request, afterState: { subject, scheduledFor },
  });
  response.status(200).json(item);
}

export async function runScheduledCommunications(request: Request, response: Response): Promise<void> {
  const result = await scheduledCommunicationService.sweep();
  if (request.user) {
    await recordAudit({ actorId: request.user.id, action: "admin.broadcast.run_due", entityType: "Broadcast", metadata: result, request });
  }
  response.status(200).json(result);
}
