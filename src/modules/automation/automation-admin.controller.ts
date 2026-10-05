import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { eventsService } from "../events/events.service";
import { automationRulesService } from "./automation-rules.service";
import { automationService } from "./automation.service";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";

function adminId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}
const body = (request: Request) => (request.body ?? {}) as Record<string, unknown>;

export async function listAutomationRules(_request: Request, response: Response): Promise<void> {
  response.json(await automationRulesService.listRules());
}

export async function updateAutomationRule(request: Request, response: Response): Promise<void> {
  const { reason, ...patch } = body(request);
  response.json({ rule: await automationRulesService.updateRule(String(request.params.id), patch, reason, adminId(request), request) });
}

function stateAction(action: "pause" | "resume" | "archive") {
  return async (request: Request, response: Response): Promise<void> => {
    response.json({ rule: await automationRulesService.setRuleState(String(request.params.id), action, body(request).reason, adminId(request), request) });
  };
}
export const pauseAutomationRule = stateAction("pause");
export const resumeAutomationRule = stateAction("resume");
export const archiveAutomationRule = stateAction("archive");

export async function duplicateAutomationRule(request: Request, response: Response): Promise<void> {
  response.status(201).json({ rule: await automationRulesService.duplicateRule(String(request.params.id), body(request).reason, adminId(request), request) });
}

export async function testAutomationRule(request: Request, response: Response): Promise<void> {
  const b = body(request);
  response.json(await automationRulesService.testRule(String(request.params.id), { recipientUserId: typeof b.recipientUserId === "string" ? b.recipientUserId : undefined, sendToMe: b.sendToMe === true }, b.reason, adminId(request), request));
}

export async function automationEmergencyStop(request: Request, response: Response): Promise<void> {
  response.json(await automationRulesService.emergencyStop(body(request).reason, adminId(request), request));
}

export async function automationReleaseEmergencyStop(request: Request, response: Response): Promise<void> {
  response.json(await automationRulesService.releaseEmergencyStop(body(request).reason, adminId(request), request));
}

export async function listAutomationRuns(request: Request, response: Response): Promise<void> {
  response.json(await automationRulesService.listRuns(request.query as Record<string, unknown>));
}

export async function retryAutomationRun(request: Request, response: Response): Promise<void> {
  const reason = requireAuditReason(body(request).reason);
  const actor = adminId(request);
  const result = await automationService.retryRun(String(request.params.id));
  await recordAudit({
    actorId: actor, action: "automation.run.retry", entityType: "AutomationRun", entityId: String(request.params.id),
    afterState: { newRunId: result.id, status: result.status }, reason, request,
  });
  response.json(result);
}

export async function getAutomationFailures(_request: Request, response: Response): Promise<void> {
  response.json(await automationRulesService.failures());
}

export async function getAutomationPerformance(_request: Request, response: Response): Promise<void> {
  response.json(await automationRulesService.performance());
}

export async function listAdminEvents(request: Request, response: Response): Promise<void> {
  const q = request.query as Record<string, string | undefined>;
  const date = (v?: string) => { const d = v ? new Date(v) : undefined; return d && !Number.isNaN(d.getTime()) ? d : undefined; };
  response.json(await eventsService.list({
    name: q.name || undefined, entityType: q.entityType || undefined, entityId: q.entityId || undefined, actorId: q.actorId || undefined,
    from: date(q.from), to: date(q.to), limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor || undefined,
  }));
}
