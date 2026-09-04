import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { fulfilmentDelayService } from "./fulfilment-delay.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

function requireNote(request: Request): string {
  const note = request.body?.note;
  if (typeof note !== "string" || !note.trim()) throw new AppError("note is required", 400);
  return note.trim();
}

export async function adminScanFulfilmentDelays(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const result = await fulfilmentDelayService.scan();
  await recordAudit({ actorId: adminId, action: "fulfilment_delay.scan", entityType: "SupplierFulfilmentAlert", metadata: result, request });
  response.json(result);
}

export async function adminListFulfilmentDelays(request: Request, response: Response): Promise<void> {
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  response.json({ items: await fulfilmentDelayService.list(status) });
}

export async function adminAddFulfilmentDelayNote(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const note = requireNote(request);
  const alert = await fulfilmentDelayService.addNote(requireIdParam(request), note);
  await recordAudit({ actorId: adminId, action: "fulfilment_delay.note_added", entityType: "SupplierFulfilmentAlert", entityId: alert.id, reason: note, request });
  response.json({ alert });
}

export async function adminContactSupplierForDelay(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const note = requireNote(request);
  const alert = await fulfilmentDelayService.contactSupplier(requireIdParam(request), adminId, note);
  await recordAudit({ actorId: adminId, action: "fulfilment_delay.supplier_contacted", entityType: "SupplierFulfilmentAlert", entityId: alert.id, reason: note, request });
  response.json({ alert });
}

export async function adminResolveFulfilmentDelay(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const note = requireNote(request);
  const alert = await fulfilmentDelayService.resolve(requireIdParam(request), adminId, note);
  await recordAudit({ actorId: adminId, action: "fulfilment_delay.resolved", entityType: "SupplierFulfilmentAlert", entityId: alert.id, reason: note, request });
  response.json({ alert });
}

export async function adminEscalateFulfilmentDelay(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const note = requireNote(request);
  const alert = await fulfilmentDelayService.escalate(requireIdParam(request), adminId, note);
  await recordAudit({ actorId: adminId, action: "fulfilment_delay.escalated", entityType: "SupplierFulfilmentAlert", entityId: alert.id, reason: note, request });
  response.json({ alert });
}
