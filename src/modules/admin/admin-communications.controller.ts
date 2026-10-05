import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { commsPauseService } from "../communications/comms-pause.service";
import { scheduledCommunicationService } from "../communications/scheduled-communication.service";
import { adminCommunicationsService, selectedChannels } from "./admin-communications.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function getChannelStatus(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.status(200).json(await adminCommunicationsService.channelStatus());
}

/**
 * Send or schedule a broadcast. Handbook 6.2: confirmed purpose/reason, 2FA
 * (route middleware), mandatory prior test-send of this exact content,
 * idempotency, audit with request context.
 */
export async function sendAdminBroadcast(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const input = adminCommunicationsService.normalizeInput(body);
  const reason = str(body.reason) ?? "";
  if (reason.length < 5) throw new AppError("A purpose/reason of at least 5 characters is required", 400);
  adminCommunicationsService.assertTestPassed(actorId, input, body.testToken);

  const scheduledFor = str(body.scheduledFor);
  if (scheduledFor) {
    const item = await scheduledCommunicationService.create({ input, reason, scheduledFor, createdBy: actorId });
    await recordAudit({
      actorId,
      action: "admin.broadcast.scheduled",
      entityType: "Broadcast",
      entityId: item.broadcastId ?? undefined,
      reason,
      afterState: { audience: input.audience, channels: selectedChannels(input), category: input.category, scheduledFor: item.scheduledFor.toISOString(), title: input.subject },
      request,
    });
    response.status(202).json({ scheduled: true, scheduledId: item.id, broadcastId: item.broadcastId, scheduledFor: item.scheduledFor });
    return;
  }

  const idempotencyKey = str(body.idempotencyKey) ?? str(request.headers["idempotency-key"]);
  const result = await adminCommunicationsService.broadcast(actorId, input, { reason, idempotencyKey });
  if (!result.duplicate) {
    await recordAudit({
      actorId,
      action: "admin.broadcast",
      entityType: "Broadcast",
      entityId: result.broadcast.id,
      reason,
      afterState: {
        audience: input.audience,
        channels: selectedChannels(input),
        category: input.category,
        title: input.subject,
        status: result.broadcast.status,
        audienceTotal: result.broadcast.audienceTotal,
        counts: result.counts,
      },
      request,
    });
  }
  response.status(result.duplicate ? 200 : 202).json(result);
}

export async function previewAdminBroadcastAudience(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const q = request.query as Record<string, unknown>;
  const channels = typeof q.channels === "string" && q.channels ? q.channels.split(",") : undefined;
  const input = adminCommunicationsService.normalizeInput({
    ...q,
    channels: channels ?? ["in_app", "push", "email"],
    // normalizeInput requires subject/body — a preview only needs the audience fields.
    subject: "preview",
    body: "preview",
  });
  const result = await adminCommunicationsService.previewAudience(
    { ...input, wantsInApp: channels ? input.wantsInApp : true, wantsPush: channels ? input.wantsPush : true, wantsEmail: channels ? input.wantsEmail : true },
    actorId,
  );
  response.status(200).json(result);
}

export async function previewAdminBroadcastMessage(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  const input = adminCommunicationsService.normalizeInput(request.body);
  const sample = (request.body?.sample ?? {}) as { name?: string; store_name?: string };
  response.status(200).json(adminCommunicationsService.preview(input, sample));
}

export async function testSendAdminBroadcast(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const input = adminCommunicationsService.normalizeInput(request.body);
  const result = await adminCommunicationsService.testSend(actorId, input);
  await recordAudit({
    actorId,
    action: "admin.broadcast.test_send",
    entityType: "Broadcast",
    metadata: { audience: input.audience, channels: result.channels, passed: result.passed, results: result.results },
    request,
  });
  response.status(200).json(result);
}

export async function listAdminBroadcasts(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  response.status(200).json(await adminCommunicationsService.listBroadcasts({
    status: str(request.query.status),
    cursor: str(request.query.cursor),
    limit: Number.isFinite(limit) ? limit : undefined,
  }));
}

export async function getAdminBroadcast(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.status(200).json(await adminCommunicationsService.getBroadcast(String(request.params.id)));
}

export async function refreshAdminBroadcastReceipts(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.status(200).json(await adminCommunicationsService.refreshReceipts(String(request.params.id)));
}

export async function searchBroadcastRecipients(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.status(200).json(await adminCommunicationsService.searchRecipients({ q: str(request.query.q), id: str(request.query.id) }));
}

// ─── Emergency pause (Super Administrator only — enforced in routes) ─────────

export async function getCommsPause(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.status(200).json(await commsPauseService.getState());
}

export async function setCommsPause(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const { commsPaused, automationsPaused, reason } = (request.body ?? {}) as {
    commsPaused?: unknown; automationsPaused?: unknown; reason?: unknown;
  };
  if (commsPaused !== undefined && typeof commsPaused !== "boolean") throw new AppError("commsPaused must be a boolean", 400);
  if (automationsPaused !== undefined && typeof automationsPaused !== "boolean") throw new AppError("automationsPaused must be a boolean", 400);
  const state = await commsPauseService.setState(
    { commsPaused: commsPaused as boolean | undefined, automationsPaused: automationsPaused as boolean | undefined },
    actorId,
    typeof reason === "string" ? reason : "",
    request,
  );
  response.status(200).json(state);
}
