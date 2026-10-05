import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { disputeV2Service } from "./dispute-v2.service";

function user(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}
function idParam(request: Request, name = "id"): string {
  const v = String(request.params[name] ?? "");
  if (!v) throw new AppError(`${name} required`, 400);
  return v;
}
const body = (request: Request): Record<string, unknown> => (request.body ?? {}) as Record<string, unknown>;

// ── buyer / vendor parties (authenticated; party check inside the service) ──
export async function partyGetDispute(request: Request, response: Response): Promise<void> {
  response.status(200).json({ dispute: await disputeV2Service.getForParty(user(request), idParam(request)) });
}
export async function partyGetDisputeByOrder(request: Request, response: Response): Promise<void> {
  response.status(200).json({ dispute: await disputeV2Service.getForPartyByOrder(user(request), idParam(request, "orderId")) });
}
export async function partyAddEvidence(request: Request, response: Response): Promise<void> {
  response.status(201).json({ evidence: await disputeV2Service.addEvidence(user(request), idParam(request), body(request)) });
}
export async function partyAddMessage(request: Request, response: Response): Promise<void> {
  response.status(201).json({ message: await disputeV2Service.addMessage(user(request), idParam(request), body(request).body) });
}
export async function partyRequestAppeal(request: Request, response: Response): Promise<void> {
  response.status(200).json(await disputeV2Service.requestAppeal(user(request), idParam(request), body(request).reason));
}

// ── admin ──
export async function adminDisputeV2Detail(request: Request, response: Response): Promise<void> {
  response.status(200).json(await disputeV2Service.getForAdmin(idParam(request)));
}
export async function adminDisputePostMessage(request: Request, response: Response): Promise<void> {
  const id = idParam(request);
  const internal = body(request).internal === true;
  const msg = await disputeV2Service.adminPostMessage(user(request), id, body(request).body, internal);
  await recordAudit({
    actorId: user(request), action: internal ? "dispute.internal_note" : "dispute.message", entityType: "Dispute", entityId: id,
    reason: String(body(request).body ?? "").slice(0, 500), afterState: { messageId: msg.id, internal }, request,
  });
  response.status(201).json({ message: msg });
}
export async function adminDisputeRequestEvidence(request: Request, response: Response): Promise<void> {
  const id = idParam(request);
  const r = await disputeV2Service.adminRequestEvidence(user(request), id, body(request));
  await recordAudit({
    actorId: user(request), action: "dispute.evidence_requested", entityType: "Dispute", entityId: id,
    reason: String(body(request).reason), beforeState: r.before as never, afterState: r.after as never, request,
  });
  response.status(200).json(r.after);
}
export async function adminDisputeDecideAppeal(request: Request, response: Response): Promise<void> {
  const id = idParam(request);
  const r = await disputeV2Service.adminDecideAppeal(user(request), id, body(request));
  await recordAudit({
    actorId: user(request), action: "dispute.appeal_decided", entityType: "Dispute", entityId: id,
    reason: String(body(request).reason), beforeState: r.before, afterState: r.after, request,
  });
  response.status(200).json(r.after);
}
