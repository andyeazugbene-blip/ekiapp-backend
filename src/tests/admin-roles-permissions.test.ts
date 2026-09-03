import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    adminRoleAssignment: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
    adminRole: { findUnique: vi.fn(), create: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed") },
}));

import { prisma } from "../lib/prisma";
import { adminRolesService } from "../modules/admin/admin-roles.service";
import { bootstrapAdmin } from "../modules/admin/admin-bootstrap";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("adminRolesService.userPermissions — fail-closed (security fix)", () => {
  it("a user with ZERO AdminRoleAssignment rows gets NO permissions — never falls back to full admin.* access", async () => {
    m.adminRoleAssignment.findMany.mockResolvedValue([]);
    const permissions = await adminRolesService.userPermissions("user-with-no-role");
    expect(permissions).toEqual([]);
    expect(permissions).not.toContain("admin.*");
  });

  it("a properly-assigned user still gets their real role's permissions", async () => {
    m.adminRoleAssignment.findMany.mockResolvedValue([
      { role: { permissions: ["orders.read", "orders.mutate"] } },
    ] as never);
    const permissions = await adminRolesService.userPermissions("user-1");
    expect(permissions).toEqual(["orders.read", "orders.mutate"]);
  });

  it("assertPermission rejects a zero-assignment user with 403, not silently granting access", async () => {
    m.adminRoleAssignment.findMany.mockResolvedValue([]);
    await expect(adminRolesService.assertPermission("unassigned-admin", "orders.mutate")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("bootstrapAdmin — backfills a real Super Administrator role assignment", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, ADMIN_EMAIL: "root@eki.test", ADMIN_PASSWORD: "a-very-long-password-123" };
  });

  it("grants Super Administrator to an already-existing admin account that has no role assignment yet", async () => {
    // Returned once by bootstrapAdmin's own lookup, then again by
    // assignRole()'s internal findFirst — both need role: ADMIN or
    // assignRole's own guard rejects the assignment.
    m.user.findFirst.mockResolvedValue({ id: "existing-admin-id", role: "ADMIN" } as never);
    m.adminRoleAssignment.findFirst.mockResolvedValue(null); // no assignment yet — the real production gap
    m.adminRole.findUnique.mockResolvedValue({ id: "role-super-admin", name: "Super Administrator" } as never);
    m.adminRoleAssignment.upsert.mockResolvedValue({} as never);

    await bootstrapAdmin();

    expect(m.adminRoleAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { roleId: "role-super-admin", userId: "existing-admin-id" } }),
    );
  });

  it("does nothing for an existing admin that already has a role assignment — no redundant writes", async () => {
    m.user.findFirst.mockResolvedValue({ id: "existing-admin-id" } as never);
    m.adminRoleAssignment.findFirst.mockResolvedValue({ id: "assignment-1" } as never);

    await bootstrapAdmin();

    expect(m.adminRoleAssignment.upsert).not.toHaveBeenCalled();
  });
});
