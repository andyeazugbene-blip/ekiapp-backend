import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminRolesService } from "./admin-roles.service";

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function listAdminRoles(_request: Request, response: Response): Promise<void> {
  const [roles, permissions] = await Promise.all([
    adminRolesService.listRoles(),
    Promise.resolve(adminRolesService.permissions()),
  ]);
  response.status(200).json({ roles, permissions });
}

export async function createAdminRole(request: Request, response: Response): Promise<void> {
  const role = await adminRolesService.createRole(request.body ?? {});
  await recordAudit({
    actorId: requireUserId(request),
    action: "admin_role.create",
    entityType: "AdminRole",
    entityId: role.id,
    metadata: { name: role.name, permissions: role.permissions },
  });
  response.status(201).json({ role });
}

export async function updateAdminRole(request: Request, response: Response): Promise<void> {
  const roleId = requireIdParam(request);
  const role = await adminRolesService.updateRole(roleId, request.body ?? {});
  await recordAudit({
    actorId: requireUserId(request),
    action: "admin_role.update",
    entityType: "AdminRole",
    entityId: role.id,
    metadata: { name: role.name, permissions: role.permissions },
  });
  response.status(200).json({ role });
}

export async function deleteAdminRole(request: Request, response: Response): Promise<void> {
  const roleId = requireIdParam(request);
  await adminRolesService.deleteRole(roleId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "admin_role.delete",
    entityType: "AdminRole",
    entityId: roleId,
  });
  response.status(204).send();
}

export async function assignAdminRole(request: Request, response: Response): Promise<void> {
  const roleId = requireIdParam(request);
  const user = typeof request.body?.user === "string" ? request.body.user.trim() : "";
  if (!user) throw new AppError("User id or email is required", 400);
  const assignment = await adminRolesService.assignRole(roleId, user);
  await recordAudit({
    actorId: requireUserId(request),
    action: "admin_role.assign",
    entityType: "AdminRoleAssignment",
    entityId: assignment.id,
    metadata: { roleId, targetUserId: assignment.userId },
  });
  response.status(201).json({ assignment });
}

export async function removeAdminRoleAssignment(request: Request, response: Response): Promise<void> {
  const assignmentId = requireIdParam(request);
  await adminRolesService.removeAssignment(assignmentId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "admin_role_assignment.delete",
    entityType: "AdminRoleAssignment",
    entityId: assignmentId,
  });
  response.status(204).send();
}
