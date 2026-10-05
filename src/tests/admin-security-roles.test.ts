/**
 * Handbook §13 / §14.12 security work: mandatory admin 2FA, admin invite flow,
 * least-privilege role seeding (idempotent), wildcard permission matching,
 * fail-closed audit and server-side reason validation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("../lib/prisma", () => {
  const prisma = {
    adminTwoFactor: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    adminRole: { findUnique: vi.fn(), create: vi.fn() },
    adminRoleAssignment: { findMany: vi.fn(), create: vi.fn(), count: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    passwordResetToken: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[])));
  return { prisma };
});
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../modules/auth/auth.service", () => ({ authService: { signTokenPublic: vi.fn().mockReturnValue("fresh-token") } }));

import { prisma } from "../lib/prisma";
import { enqueueEmail } from "../lib/email-queue";
import { require2fa } from "../middlewares/require-2fa";
import { isAdmin2faEnforced } from "../config/admin-2fa";
import { recordAudit, requireAuditReason } from "../shared/utils/audit";
import { adminRolesService, ADMIN_PERMISSIONS, permissionMatches } from "../modules/admin/admin-roles.service";
import { adminTeamService } from "../modules/admin/admin-team.service";
import { maskEmail, maskPhone } from "../shared/utils/mask";

const m = vi.mocked(prisma, true);
const ENV = { ...process.env };

function run2fa(headers: Record<string, string> = {}) {
  const req = { user: { id: "admin-1", role: "ADMIN", email: "a@x.test" }, headers } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  return require2fa(req, {} as Response, next).then(() => (next as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[])));
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("ADMIN_2FA_ENFORCE switch", () => {
  it("defaults off outside production and on in production; explicit value wins", () => {
    delete process.env.ADMIN_2FA_ENFORCE;
    process.env.NODE_ENV = "test";
    expect(isAdmin2faEnforced()).toBe(false);
    process.env.NODE_ENV = "production";
    expect(isAdmin2faEnforced()).toBe(true);
    process.env.ADMIN_2FA_ENFORCE = "false";
    expect(isAdmin2faEnforced()).toBe(false);
    process.env.NODE_ENV = "development";
    process.env.ADMIN_2FA_ENFORCE = "true";
    expect(isAdmin2faEnforced()).toBe(true);
  });
});

describe("require2fa enforcement matrix", () => {
  it("not enrolled + enforcement off -> passes through (dev/test)", async () => {
    process.env.ADMIN_2FA_ENFORCE = "false";
    m.adminTwoFactor.findUnique.mockResolvedValue(null);
    expect(await run2fa()).toBeUndefined();
  });

  it("not enrolled + enforcement on -> 403 TWO_FACTOR_SETUP_REQUIRED", async () => {
    process.env.ADMIN_2FA_ENFORCE = "true";
    m.adminTwoFactor.findUnique.mockResolvedValue(null);
    expect(await run2fa()).toMatchObject({ statusCode: 403, code: "TWO_FACTOR_SETUP_REQUIRED" });
  });

  it("record exists but not enabled + enforcement on -> 403 TWO_FACTOR_SETUP_REQUIRED", async () => {
    process.env.ADMIN_2FA_ENFORCE = "true";
    m.adminTwoFactor.findUnique.mockResolvedValue({ id: "t", enabled: false, secret: "", backupCodes: [] } as never);
    expect(await run2fa()).toMatchObject({ code: "TWO_FACTOR_SETUP_REQUIRED" });
  });

  it("enrolled, no code header -> 2FA_REQUIRED regardless of the switch", async () => {
    process.env.ADMIN_2FA_ENFORCE = "false";
    m.adminTwoFactor.findUnique.mockResolvedValue({ id: "t", enabled: true, secret: "JBSWY3DPEHPK3PXP", backupCodes: [] } as never);
    expect(await run2fa()).toMatchObject({ statusCode: 403, code: "2FA_REQUIRED" });
  });

  it("enrolled, wrong code -> 2FA_INVALID", async () => {
    m.adminTwoFactor.findUnique.mockResolvedValue({ id: "t", enabled: true, secret: "JBSWY3DPEHPK3PXP", backupCodes: [] } as never);
    expect(await run2fa({ "x-2fa-code": "000000" })).toMatchObject({ code: "2FA_INVALID" });
  });
});

describe("permissionMatches — wildcard aware", () => {
  it("handles exact, admin.* and prefix.* grants", () => {
    expect(permissionMatches(["orders.read"], "orders.read")).toBe(true);
    expect(permissionMatches(["orders.read"], "orders.mutate")).toBe(false);
    expect(permissionMatches(["admin.*"], "anything.at_all")).toBe(true);
    expect(permissionMatches(["orders.*"], "orders.mutate")).toBe(true);
    expect(permissionMatches(["orders.*"], "orders_extra.read")).toBe(false);
    expect(permissionMatches(["orders.*"], "payments.mutate")).toBe(false);
    expect(permissionMatches([], "orders.read")).toBe(false);
  });

  it("catalogue contains the permissions that routes use but were previously missing", () => {
    for (const p of ["rewards.read", "rewards.mutate", "content.read", "content.mutate", "subscriptions.read", "subscriptions.mutate"]) {
      expect(ADMIN_PERMISSIONS).toContain(p);
    }
    expect(new Set(ADMIN_PERMISSIONS).size).toBe(ADMIN_PERMISSIONS.length);
  });

  it("assertPermission honours a prefix wildcard held through a role", async () => {
    m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["orders.*"] } }] as never);
    await expect(adminRolesService.assertPermission("u", "orders.mutate")).resolves.toBeUndefined();
    await expect(adminRolesService.assertPermission("u", "payouts.mutate")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("role seeding — idempotent, least privilege", () => {
  it("creates only missing roles, never touches existing ones, includes Operations Admin and Finance Admin", async () => {
    const existing = new Set(["Super Administrator", "Customer Support"]);
    m.adminRole.findUnique.mockImplementation((async ({ where }: { where: { name: string } }) => (existing.has(where.name) ? { id: "x" } : null)) as never);
    m.adminRole.create.mockResolvedValue({} as never);

    await adminRolesService.seedDefaultRoles();
    const created = m.adminRole.create.mock.calls.map((c) => (c[0] as { data: { name: string } }).data.name);
    expect(created).toContain("Operations Admin");
    expect(created).toContain("Finance Admin");
    expect(created).not.toContain("Super Administrator");
    expect(created).not.toContain("Customer Support");

    // second run on a fully-seeded DB creates nothing
    m.adminRole.create.mockClear();
    m.adminRole.findUnique.mockResolvedValue({ id: "x" } as never);
    await adminRolesService.seedDefaultRoles();
    expect(m.adminRole.create).not.toHaveBeenCalled();
  });

  it("Operations Admin cannot move money or edit settings/roles; Finance Admin cannot administer users/vendors", async () => {
    m.adminRole.findUnique.mockResolvedValue(null);
    m.adminRole.create.mockResolvedValue({} as never);
    await adminRolesService.seedDefaultRoles();
    const byName = new Map(m.adminRole.create.mock.calls.map((c) => [(c[0] as { data: { name: string } }).data.name, (c[0] as { data: { permissions: string[] } }).data.permissions]));
    const ops = byName.get("Operations Admin")!;
    const fin = byName.get("Finance Admin")!;
    for (const p of ["payments.mutate", "payouts.mutate", "settings.mutate", "roles.mutate", "security.mutate", "admin.*", "community_buy.mutate"]) expect(ops).not.toContain(p);
    for (const p of ["users.mutate", "vendors.mutate", "settings.mutate", "roles.mutate", "admin.*", "communications.send"]) expect(fin).not.toContain(p);
    expect(fin).toContain("payouts.mutate");
    expect(ops).toContain("users.mutate");
    // every seeded permission must exist in the catalogue
    for (const perms of byName.values()) for (const p of perms) expect(ADMIN_PERMISSIONS as readonly string[]).toContain(p);
  });
});

describe("recordAudit failClosed + reason validation", () => {
  it("swallows a write failure by default but rethrows AUDIT_WRITE_FAILED when failClosed", async () => {
    m.auditLog.create.mockRejectedValue(new Error("db down"));
    await expect(recordAudit({ actorId: "a", action: "x", entityType: "T" })).resolves.toBeUndefined();
    await expect(recordAudit({ actorId: "a", action: "x", entityType: "T", failClosed: true })).rejects.toMatchObject({
      statusCode: 500,
      code: "AUDIT_WRITE_FAILED",
    });
  });

  it("requireAuditReason trims, enforces >= 5 chars and a max length", () => {
    expect(requireAuditReason("  fraud review  ")).toBe("fraud review");
    for (const bad of [undefined, null, "", "    ", "abcd", 42]) {
      expect(() => requireAuditReason(bad)).toThrowError(expect.objectContaining({ statusCode: 400, code: "REASON_REQUIRED" }));
    }
    expect(() => requireAuditReason("x".repeat(1001))).toThrowError(expect.objectContaining({ code: "REASON_TOO_LONG" }));
  });
});

describe("admin invite flow", () => {
  const actor = { id: "super-1", name: "Root" };
  const role = { id: "role-ops", name: "Operations Admin", permissions: ["orders.read"] };

  it("creates an ADMIN with no password, assigns the role, mints a one-time token, emails it and audits fail-closed with reason", async () => {
    m.adminRole.findUnique.mockResolvedValue(role as never);
    m.user.findUnique.mockResolvedValue(null);
    m.user.create.mockResolvedValue({ id: "new-admin", name: "Nia", email: "nia@eki.test" } as never);
    m.auditLog.create.mockResolvedValue({} as never);

    const result = await adminTeamService.invite(actor, { email: "Nia@Eki.test", name: "Nia", roleId: "role-ops", reason: "new ops hire" });

    expect(m.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ email: "nia@eki.test", role: "ADMIN", password: null }) });
    expect(m.adminRoleAssignment.create).toHaveBeenCalledWith({ data: { roleId: "role-ops", userId: "new-admin" } });
    const tokenCall = m.passwordResetToken.create.mock.calls[0][0] as { data: { userId: string; token: string; expiresAt: Date } };
    expect(tokenCall.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenCall.data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 71 * 3600 * 1000);
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "nia@eki.test" }));
    const audit = m.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ action: "admin.invite", reason: "new ops hire", entityId: "new-admin" });
    expect(result.admin.email).toBe("nia@eki.test");
  });

  it("requires a reason, a valid email and refuses duplicate emails", async () => {
    await expect(adminTeamService.invite(actor, { email: "a@b.co", name: "Nia", roleId: "r" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(adminTeamService.invite(actor, { email: "nope", name: "Nia", roleId: "r", reason: "valid reason" })).rejects.toMatchObject({ statusCode: 400 });
    m.adminRole.findUnique.mockResolvedValue(role as never);
    m.user.findUnique.mockResolvedValue({ id: "u", role: "BUYER" } as never);
    await expect(adminTeamService.invite(actor, { email: "a@b.co", name: "Nia", roleId: "r", reason: "valid reason" })).rejects.toMatchObject({ statusCode: 409, code: "EMAIL_IN_USE" });
  });

  it("only a Super Administrator may invite someone into a role that carries admin.*", async () => {
    m.adminRole.findUnique.mockResolvedValue({ id: "role-super", name: "Super Administrator", permissions: ["admin.*"] } as never);
    m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["roles.mutate"] } }] as never);
    await expect(adminTeamService.invite(actor, { email: "a@b.co", name: "Nia", roleId: "role-super", reason: "valid reason" })).rejects.toMatchObject({ code: "SUPER_ADMIN_REQUIRED" });
  });

  it("cannot deactivate yourself or the last active Super Administrator", async () => {
    await expect(adminTeamService.setActive("a", "a", false, "leaving the team")).rejects.toMatchObject({ code: "SELF_DEACTIVATION" });
    m.user.findUnique.mockResolvedValue({ id: "b", role: "ADMIN", isSuspended: false } as never);
    m.user.findFirst.mockResolvedValue({ id: "b" } as never);
    m.user.count.mockResolvedValue(1);
    await expect(adminTeamService.setActive("a", "b", false, "leaving the team")).rejects.toMatchObject({ code: "LAST_SUPER_ADMIN" });
  });

  it("deactivation suspends and bumps tokenVersion so the admin is signed out everywhere", async () => {
    m.user.findUnique.mockResolvedValue({ id: "b", role: "ADMIN", isSuspended: false } as never);
    m.user.findFirst.mockResolvedValue(null); // not a super admin
    m.user.update.mockResolvedValue({} as never);
    m.auditLog.create.mockResolvedValue({} as never);
    await adminTeamService.setActive("a", "b", false, "left the company");
    expect(m.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isSuspended: true, tokenVersion: { increment: 1 } }) }));
    expect((m.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({ action: "admin.deactivate", reason: "left the company" });
  });

  it("revoke-other-sessions bumps tokenVersion, audits and returns a fresh token", async () => {
    m.user.update.mockResolvedValue({ id: "a", role: "ADMIN", email: "a@x", tokenVersion: 5 } as never);
    m.auditLog.create.mockResolvedValue({} as never);
    const res = await adminTeamService.revokeOtherSessions({ id: "a", role: "ADMIN", email: "a@x" } as never, "lost my laptop");
    expect(res.token).toBe("fresh-token");
    expect(m.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { tokenVersion: { increment: 1 } } }));
  });
});

describe("privacy masks", () => {
  it("masks email and phone", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j•••@example.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskPhone("+353871234567")).toMatch(/4567$/);
    expect(maskPhone("+353871234567")).not.toContain("87123");
  });
});
