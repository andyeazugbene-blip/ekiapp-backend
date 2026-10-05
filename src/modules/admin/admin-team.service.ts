import crypto from "crypto";

import type { Request } from "express";
import { UserRole } from "@prisma/client";

import { isAdmin2faEnforced } from "../../config/admin-2fa";
import { env } from "../../config/env";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { authService } from "../auth/auth.service";
import { adminRolesService, permissionMatches } from "./admin-roles.service";

export const ADMIN_INVITE_EXPIRY_HOURS = 72;
const SUPER_ADMIN_ROLE = "Super Administrator";

function adminWebBaseUrl(): string {
  return (process.env.ADMIN_WEB_URL ?? env.frontendUrl).replace(/\/+$/, "");
}

async function isSuperAdmin(userId: string): Promise<boolean> {
  const perms = await adminRolesService.userPermissions(userId);
  return permissionMatches(perms, "admin.*") && perms.includes("admin.*");
}

/** Counts ADMIN users that are active and hold the Super Administrator role. */
async function activeSuperAdminCount(): Promise<number> {
  return prisma.user.count({
    where: {
      role: UserRole.ADMIN,
      isSuspended: false,
      adminRoleAssignments: { some: { role: { name: SUPER_ADMIN_ROLE } } },
    },
  });
}

async function targetIsActiveSuperAdmin(userId: string): Promise<boolean> {
  const row = await prisma.user.findFirst({
    where: { id: userId, isSuspended: false, adminRoleAssignments: { some: { role: { name: SUPER_ADMIN_ROLE } } } },
    select: { id: true },
  });
  return Boolean(row);
}

async function requireAdminTarget(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, isSuspended: true, tokenVersion: true },
  });
  if (!user || user.role !== UserRole.ADMIN) throw new AppError("Admin user not found", 404);
  return user;
}

export const adminTeamService = {
  /** GET /admin/me/permissions — effective permissions + 2FA posture of the caller. */
  async myAccess(userId: string) {
    const [permissions, assignments, twoFactor] = await Promise.all([
      adminRolesService.userPermissions(userId),
      prisma.adminRoleAssignment.findMany({ where: { userId }, include: { role: { select: { id: true, name: true } } } }),
      prisma.adminTwoFactor.findUnique({ where: { userId }, select: { enabled: true } }),
    ]);
    const enabled = Boolean(twoFactor?.enabled);
    const enforced = isAdmin2faEnforced();
    return {
      permissions,
      roles: assignments.map((a) => a.role),
      isSuperAdmin: permissions.includes("admin.*"),
      twoFactor: { enabled, enforced, setupRequired: enforced && !enabled },
    };
  },

  async listAdmins() {
    const admins = await prisma.user.findMany({
      where: { role: UserRole.ADMIN },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        isSuspended: true,
        suspendedReason: true,
        suspendedAt: true,
        createdAt: true,
        lastActiveAt: true,
        password: true,
        adminTwoFactor: { select: { enabled: true } },
        adminRoleAssignments: { select: { id: true, role: { select: { id: true, name: true } } } },
      },
    });
    const lastActions = admins.length
      ? await prisma.auditLog.groupBy({
          by: ["actorId"],
          where: { actorId: { in: admins.map((a) => a.id) } },
          _max: { createdAt: true },
        })
      : [];
    const lastByActor = new Map(lastActions.map((row) => [row.actorId, row._max.createdAt]));
    return admins.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      status: a.isSuspended ? "DEACTIVATED" : a.password ? "ACTIVE" : "INVITED",
      deactivatedReason: a.suspendedReason,
      deactivatedAt: a.suspendedAt,
      createdAt: a.createdAt,
      // Honest: there is no session table. "Last activity" is the later of
      // User.lastActiveAt (if some flow sets it) and the latest audited action.
      lastActivityAt:
        [a.lastActiveAt, lastByActor.get(a.id) ?? null]
          .filter((d): d is Date => Boolean(d))
          .sort((x, y) => y.getTime() - x.getTime())[0] ?? null,
      twoFactorEnabled: Boolean(a.adminTwoFactor?.enabled),
      roles: a.adminRoleAssignments.map((r) => ({ assignmentId: r.id, ...r.role })),
    }));
  },

  async invite(
    actor: { id: string; name?: string },
    input: { email?: unknown; name?: unknown; roleId?: unknown; reason?: unknown },
    request?: Request,
  ) {
    const reason = requireAuditReason(input.reason);
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const roleId = typeof input.roleId === "string" ? input.roleId : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("A valid email is required", 400);
    if (name.length < 2 || name.length > 80) throw new AppError("Name must be 2-80 characters", 400);
    if (!roleId) throw new AppError("roleId is required", 400);

    const role = await prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!role) throw new AppError("Admin role not found", 404);
    // Handing out full admin.* is a super-admin-only act.
    if (role.permissions.includes("admin.*") && !(await isSuperAdmin(actor.id))) {
      throw new AppError("Only a Super Administrator can invite another Super Administrator", 403, null, "SUPER_ADMIN_REQUIRED");
    }

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
    if (existing) {
      throw new AppError(
        existing.role === UserRole.ADMIN ? "An admin with this email already exists" : "This email already belongs to a non-admin account",
        409,
        null,
        "EMAIL_IN_USE",
      );
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + ADMIN_INVITE_EXPIRY_HOURS * 3600 * 1000);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, name, role: UserRole.ADMIN, password: null, emailVerifiedAt: new Date() },
      });
      await tx.adminRoleAssignment.create({ data: { roleId: role.id, userId: created.id } });
      await tx.passwordResetToken.create({ data: { userId: created.id, token, expiresAt } });
      return created;
    });

    await recordAudit({
      actorId: actor.id,
      action: "admin.invite",
      entityType: "User",
      entityId: user.id,
      reason,
      afterState: { email, name, roleId: role.id, roleName: role.name },
      request,
      failClosed: true,
    });

    const setPasswordUrl = `${adminWebBaseUrl()}/set-password?token=${token}`;
    const template = emailTemplates.adminInvite({
      name,
      inviterName: actor.name ?? "An Eki administrator",
      roleName: role.name,
      setPasswordUrl,
      expiresHours: ADMIN_INVITE_EXPIRY_HOURS,
    });
    await enqueueEmail({ to: email, subject: template.subject, html: template.html });

    return {
      admin: { id: user.id, name: user.name, email: user.email, roleName: role.name },
      expiresAt,
      // Never expose the one-time link in production responses; locally it is the
      // only way to complete the flow without a configured mail provider.
      ...(env.nodeEnv === "production" ? {} : { setPasswordUrl }),
    };
  },

  async setActive(actorId: string, targetId: string, active: boolean, rawReason: unknown, request?: Request) {
    const reason = requireAuditReason(rawReason);
    if (!active && actorId === targetId) throw new AppError("You cannot deactivate your own account", 409, null, "SELF_DEACTIVATION");
    const target = await requireAdminTarget(targetId);
    if (target.isSuspended === !active) throw new AppError(active ? "Admin is already active" : "Admin is already deactivated", 409);
    if (!active && (await targetIsActiveSuperAdmin(targetId)) && (await activeSuperAdminCount()) <= 1) {
      throw new AppError("The last active Super Administrator cannot be deactivated", 409, null, "LAST_SUPER_ADMIN");
    }
    if (!active && (await targetIsActiveSuperAdmin(targetId)) && !(await isSuperAdmin(actorId))) {
      throw new AppError("Only a Super Administrator can deactivate a Super Administrator", 403, null, "SUPER_ADMIN_REQUIRED");
    }

    await prisma.user.update({
      where: { id: targetId },
      data: active
        ? { isSuspended: false, suspendedReason: null, suspendedAt: null, suspendedById: null }
        : { isSuspended: true, suspendedReason: reason, suspendedAt: new Date(), suspendedById: actorId, tokenVersion: { increment: 1 } },
    });
    await recordAudit({
      actorId,
      action: active ? "admin.reactivate" : "admin.deactivate",
      entityType: "User",
      entityId: targetId,
      reason,
      beforeState: { isSuspended: target.isSuspended },
      afterState: { isSuspended: !active },
      request,
      failClosed: true,
    });
    return { id: targetId, status: active ? "ACTIVE" : "DEACTIVATED" };
  },

  /** Replace an admin's role (single-role model for the Team UI). */
  async changeRole(actorId: string, targetId: string, rawRoleId: unknown, rawReason: unknown, request?: Request) {
    const reason = requireAuditReason(rawReason);
    const roleId = typeof rawRoleId === "string" ? rawRoleId : "";
    if (!roleId) throw new AppError("roleId is required", 400);
    if (actorId === targetId) throw new AppError("You cannot change your own role", 409, null, "SELF_ROLE_CHANGE");
    await requireAdminTarget(targetId);
    const role = await prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!role) throw new AppError("Admin role not found", 404);

    const actorIsSuper = await isSuperAdmin(actorId);
    if (role.permissions.includes("admin.*") && !actorIsSuper) {
      throw new AppError("Only a Super Administrator can grant Super Administrator", 403, null, "SUPER_ADMIN_REQUIRED");
    }
    const wasSuper = await targetIsActiveSuperAdmin(targetId);
    if (wasSuper && !actorIsSuper) {
      throw new AppError("Only a Super Administrator can change a Super Administrator's role", 403, null, "SUPER_ADMIN_REQUIRED");
    }
    if (wasSuper && role.name !== SUPER_ADMIN_ROLE && (await activeSuperAdminCount()) <= 1) {
      throw new AppError("The last active Super Administrator cannot be demoted", 409, null, "LAST_SUPER_ADMIN");
    }

    const before = await prisma.adminRoleAssignment.findMany({ where: { userId: targetId }, include: { role: { select: { id: true, name: true } } } });
    await prisma.$transaction([
      prisma.adminRoleAssignment.deleteMany({ where: { userId: targetId, NOT: { roleId } } }),
      prisma.adminRoleAssignment.upsert({
        where: { roleId_userId: { roleId, userId: targetId } },
        create: { roleId, userId: targetId },
        update: {},
      }),
      // Permissions are read live, but bump the token anyway so the change is
      // reflected in any cached client state on next request.
      prisma.user.update({ where: { id: targetId }, data: { tokenVersion: { increment: 1 } } }),
    ]);
    await recordAudit({
      actorId,
      action: "admin_role.change",
      entityType: "User",
      entityId: targetId,
      reason,
      beforeState: { roles: before.map((a) => a.role.name) },
      afterState: { roles: [role.name] },
      request,
      failClosed: true,
    });
    return { id: targetId, role: { id: role.id, name: role.name } };
  },

  /**
   * Sign out every other session of the caller: bumps tokenVersion (the only
   * revocation primitive — there is no per-device session table) and returns a
   * fresh token so the current browser stays signed in.
   */
  async revokeOtherSessions(actor: { id: string; role: UserRole; email: string }, rawReason: unknown, request?: Request) {
    const reason = requireAuditReason(rawReason);
    const updated = await prisma.user.update({
      where: { id: actor.id },
      data: { tokenVersion: { increment: 1 } },
      select: { id: true, role: true, email: true, tokenVersion: true },
    });
    await recordAudit({
      actorId: actor.id,
      action: "admin.sessions.revoke_others",
      entityType: "User",
      entityId: actor.id,
      reason,
      request,
      failClosed: true,
    });
    return { token: authService.signTokenPublic(updated) };
  },
};

/** GET /admin/integrations/status — booleans only, never values. */
export function integrationsStatus() {
  const has = (name: string) => Boolean(process.env[name] && String(process.env[name]).trim());
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  return {
    integrations: [
      {
        key: "stripe",
        label: "Stripe",
        configured: has("STRIPE_SECRET_KEY"),
        detail: has("STRIPE_SECRET_KEY") ? (stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_") ? "Live mode key" : "Test mode key") : "Secret key missing",
        checks: [
          { label: "Webhook signing secret", ok: has("STRIPE_WEBHOOK_SECRET") },
          { label: "Identity webhook secret", ok: has("STRIPE_IDENTITY_WEBHOOK_SECRET") },
        ],
      },
      { key: "resend", label: "Email (Resend)", configured: has("RESEND_API_KEY"), detail: has("RESEND_API_KEY") ? "API key present" : "Not configured: emails are logged, not sent", checks: [{ label: "From address set", ok: has("EMAIL_FROM") }] },
      { key: "expo_push", label: "Push (Expo)", configured: has("EXPO_ACCESS_TOKEN"), detail: has("EXPO_ACCESS_TOKEN") ? "Access token present" : "Access token missing", checks: [] },
      { key: "paystack", label: "Paystack", configured: has("PAYSTACK_SECRET_KEY"), detail: has("PAYSTACK_SECRET_KEY") ? "Secret key present" : "Not configured", checks: [] },
      { key: "storage", label: "File storage (S3)", configured: has("S3_BUCKET") && has("S3_ACCESS_KEY_ID") && has("S3_SECRET_ACCESS_KEY"), detail: has("S3_BUCKET") ? "Bucket configured" : "Not configured", checks: [] },
      { key: "redis", label: "Redis", configured: has("REDIS_URL"), detail: has("REDIS_URL") ? "URL present" : "Not configured", checks: [] },
      { key: "sentry", label: "Error monitoring (Sentry)", configured: has("SENTRY_DSN"), detail: has("SENTRY_DSN") ? "DSN present" : "Not configured", checks: [] },
      { key: "ops_alerts", label: "Ops alert email", configured: has("OPS_ALERT_EMAIL"), detail: has("OPS_ALERT_EMAIL") ? "Recipient set" : "Not set", checks: [] },
    ],
    system: {
      version: process.env.npm_package_version ?? "1.3.0",
      environment: env.nodeEnv,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null,
      nodeVersion: process.version,
      admin2faEnforced: isAdmin2faEnforced(),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
  };
}
