import { UserRole } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export const ADMIN_PERMISSIONS = [
  "admin.*",
  "dashboard.read",
  "analytics.read",
  "users.read",
  "users.mutate",
  "vendors.read",
  "vendors.mutate",
  "orders.read",
  "orders.mutate",
  "payments.mutate",
  "payouts.read",
  "payouts.mutate",
  "products.read",
  "products.mutate",
  "reviews.read",
  "reviews.mutate",
  "verification.read",
  "verification.mutate",
  "delivery_zones.read",
  "delivery_zones.mutate",
  "disputes.read",
  "disputes.mutate",
  "escrow.read",
  "communications.read",
  "communications.send",
  "promos.read",
  "promos.mutate",
  "subscriptions.read",
  "subscriptions.mutate",
  "settings.read",
  "settings.mutate",
  "security.mutate",
  "roles.read",
  "roles.mutate",
  "audit.read",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

function normalizePermissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AppError("permissions must be an array", 400);
  const set = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || !ADMIN_PERMISSIONS.includes(value as AdminPermission)) {
      throw new AppError(`Invalid permission: ${String(value)}`, 400);
    }
    set.add(value);
  }
  return [...set];
}

function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length < 2) throw new AppError("Role name is required", 400);
  if (name.length > 80) throw new AppError("Role name is too long", 400);
  return name;
}

export const adminRolesService = {
  permissions() {
    return ADMIN_PERMISSIONS;
  },

  async listRoles() {
    return prisma.adminRole.findMany({
      include: {
        assignments: {
          include: {
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        },
      },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    });
  },

  async createRole(input: { name?: unknown; description?: unknown; permissions?: unknown }) {
    const name = normalizeName(input.name);
    const description = typeof input.description === "string" ? input.description.trim() : null;
    const permissions = normalizePermissions(input.permissions ?? []);

    return prisma.adminRole.create({
      data: { name, description, permissions },
    });
  },

  async updateRole(roleId: string, input: { name?: unknown; description?: unknown; permissions?: unknown }) {
    const existing = await prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!existing) throw new AppError("Admin role not found", 404);

    return prisma.adminRole.update({
      where: { id: roleId },
      data: {
        ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
        ...(input.description !== undefined ? { description: typeof input.description === "string" ? input.description.trim() : null } : {}),
        ...(input.permissions !== undefined ? { permissions: normalizePermissions(input.permissions) } : {}),
      },
    });
  },

  async deleteRole(roleId: string) {
    const existing = await prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!existing) throw new AppError("Admin role not found", 404);
    if (existing.isSystem) throw new AppError("System roles cannot be deleted", 409);
    await prisma.adminRole.delete({ where: { id: roleId } });
  },

  async assignRole(roleId: string, userIdOrEmail: string) {
    const role = await prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!role) throw new AppError("Admin role not found", 404);

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ id: userIdOrEmail }, { email: userIdOrEmail.toLowerCase() }],
      },
    });
    if (!user) throw new AppError("User not found", 404);
    if (user.role !== UserRole.ADMIN) throw new AppError("Only ADMIN users can receive admin roles", 400);

    return prisma.adminRoleAssignment.upsert({
      where: { roleId_userId: { roleId, userId: user.id } },
      create: { roleId, userId: user.id },
      update: {},
      include: { user: { select: { id: true, name: true, email: true, role: true } }, role: true },
    });
  },

  async removeAssignment(assignmentId: string) {
    await prisma.adminRoleAssignment.delete({ where: { id: assignmentId } });
  },

  async userPermissions(userId: string): Promise<string[]> {
    const assignments = await prisma.adminRoleAssignment.findMany({
      where: { userId },
      include: { role: true },
    });

    if (assignments.length === 0) return ["admin.*"];
    return [...new Set(assignments.flatMap((assignment) => assignment.role.permissions))];
  },

  async assertPermission(userId: string, permission: string) {
    const permissions = await this.userPermissions(userId);
    if (!permissions.includes("admin.*") && !permissions.includes(permission)) {
      throw new AppError("Admin role does not have permission for this action", 403, null, "ADMIN_PERMISSION_DENIED");
    }
  },
};
