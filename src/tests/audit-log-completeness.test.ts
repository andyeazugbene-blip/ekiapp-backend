/**
 * Audit log completeness (architecture gap closure). recordAudit() now
 * accepts beforeState/afterState/reason directly, and auto-derives
 * permissionUsed/ipAddress from a passed `request` — so most call sites
 * get real IP/permission capture just by adding `request`, without
 * fabricating a value when one genuinely isn't available.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: { auditLog: { create: vi.fn() } },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { recordAudit } from "../shared/utils/audit";
import { requireAdminPermission } from "../middlewares/require-admin-permission";

vi.mock("../modules/admin/admin-roles.service", () => ({
  adminRolesService: { assertPermission: vi.fn().mockResolvedValue(undefined) },
}));

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("recordAudit — real fields, never fabricated", () => {
  it("persists beforeState/afterState/reason when the caller provides them", async () => {
    await recordAudit({
      actorId: "admin-1",
      action: "vendor.suspend",
      entityType: "Vendor",
      entityId: "vendor-1",
      reason: "repeated policy violations",
      beforeState: { isSuspended: false },
      afterState: { isSuspended: true },
    });

    expect(m.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reason: "repeated policy violations",
        beforeState: { isSuspended: false },
        afterState: { isSuspended: true },
      }),
    });
  });

  it("stores null (not a fabricated value) for fields the caller never provided", async () => {
    await recordAudit({ actorId: "admin-1", action: "vendor.invite", entityType: "Vendor", entityId: "v@example.com" });

    const call = m.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.reason).toBeNull();
    expect(call.data.permissionUsed).toBeNull();
    expect(call.data.ipAddress).toBeNull();
  });

  it("auto-derives permissionUsed and ipAddress from a passed request, without the caller doing anything extra", async () => {
    const fakeRequest = { usedPermission: "vendors.mutate", ip: "203.0.113.5" } as never;

    await recordAudit({ actorId: "admin-1", action: "vendor.suspend", entityType: "Vendor", entityId: "vendor-1", request: fakeRequest });

    expect(m.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ permissionUsed: "vendors.mutate", ipAddress: "203.0.113.5" }),
    });
  });

  it("never throws when the write fails — audit failures must not break the request path", async () => {
    m.auditLog.create.mockRejectedValue(new Error("db down"));
    await expect(recordAudit({ actorId: "admin-1", action: "x", entityType: "Y" })).resolves.toBeUndefined();
  });
});

describe("requireAdminPermission — sets request.usedPermission for recordAudit to pick up", () => {
  it("stamps the exact permission string it checked onto the request before calling next()", async () => {
    const request = { user: { id: "admin-1", role: "ADMIN", email: "a@example.com" } } as { usedPermission?: string; user?: unknown };
    const next = vi.fn();

    await requireAdminPermission("vendors.mutate")(request as never, {} as never, next);

    expect(request.usedPermission).toBe("vendors.mutate");
    expect(next).toHaveBeenCalledWith(); // called with no error — permission granted
  });

  it("never stamps usedPermission when the request is unauthenticated", async () => {
    const request = {} as { usedPermission?: string; user?: unknown };
    const next = vi.fn();

    await requireAdminPermission("vendors.mutate")(request as never, {} as never, next);

    expect(request.usedPermission).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
