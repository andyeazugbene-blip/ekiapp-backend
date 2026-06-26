import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { communicationService } from "./communication.service";
import { scheduledCommunicationService } from "./scheduled-communication.service";

export async function listCommunicationLogs(request: Request, response: Response): Promise<void> {
  const eventKey = typeof request.query.eventKey === "string" ? request.query.eventKey : undefined;
  const recipientType = typeof request.query.recipientType === "string" ? request.query.recipientType : undefined;
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  const offset = request.query.offset ? Number(request.query.offset) : undefined;

  const result = await communicationService.listLogs({ eventKey, recipientType, status, limit, offset });
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
  const key = request.params.key as string;
  if (!key) throw new AppError("Template key is required", 400);

  const { title, body, channels, enabled } = request.body as {
    title?: string; body?: string; channels?: string[]; enabled?: boolean;
  };

  const updated = await communicationService.updateTemplate(key, { title, body, channels, enabled });
  response.status(200).json(updated);
}

// ─── Scheduled Communications ───────────────────────────────────────────────

export async function createScheduledCommunication(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const { audience, channel, templateKey, subject, body, scheduledFor } = request.body as {
    audience: string; channel: string; templateKey?: string;
    subject: string; body: string; scheduledFor: string;
  };

  if (!audience || !channel || !subject || !body || !scheduledFor) {
    throw new AppError("audience, channel, subject, body, and scheduledFor are required", 400);
  }

  const item = await scheduledCommunicationService.create({
    audience, channel, templateKey, subject, body, scheduledFor,
    createdBy: request.user.id,
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
  const id = request.params.id as string;
  if (!id) throw new AppError("ID is required", 400);
  const item = await scheduledCommunicationService.cancel(id);
  response.status(200).json(item);
}

export async function runScheduledCommunications(_request: Request, response: Response): Promise<void> {
  const result = await scheduledCommunicationService.runDue();
  response.status(200).json(result);
}
