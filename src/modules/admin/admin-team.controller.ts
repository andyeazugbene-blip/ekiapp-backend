import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { adminTeamService, integrationsStatus } from "./admin-team.service";

function actor(request: Request) {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user;
}

function idParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || !id) throw new AppError("Invalid id", 400);
  return id;
}

export async function getMyPermissions(request: Request, response: Response): Promise<void> {
  response.json(await adminTeamService.myAccess(actor(request).id));
}

export async function listAdminAccounts(_request: Request, response: Response): Promise<void> {
  response.json({ admins: await adminTeamService.listAdmins() });
}

export async function inviteAdmin(request: Request, response: Response): Promise<void> {
  const user = actor(request);
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
  const result = await adminTeamService.invite({ id: user.id, name: me?.name }, request.body ?? {}, request);
  response.status(201).json(result);
}

export async function deactivateAdmin(request: Request, response: Response): Promise<void> {
  response.json(await adminTeamService.setActive(actor(request).id, idParam(request), false, request.body?.reason, request));
}

export async function reactivateAdmin(request: Request, response: Response): Promise<void> {
  response.json(await adminTeamService.setActive(actor(request).id, idParam(request), true, request.body?.reason, request));
}

export async function changeAdminRole(request: Request, response: Response): Promise<void> {
  response.json(await adminTeamService.changeRole(actor(request).id, idParam(request), request.body?.roleId, request.body?.reason, request));
}

export async function revokeOtherSessions(request: Request, response: Response): Promise<void> {
  response.json(await adminTeamService.revokeOtherSessions(actor(request), request.body?.reason, request));
}

export async function getIntegrationsStatus(_request: Request, response: Response): Promise<void> {
  response.json(integrationsStatus());
}
