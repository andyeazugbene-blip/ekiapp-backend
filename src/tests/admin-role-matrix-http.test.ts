/**
 * Direct HTTP authorization matrix through the REAL Express router + real permission
 * middleware. Only the DB-backed permission lookup and 2FA are stubbed (per-user), so a
 * 403 here proves the SERVER refuses - UI hiding is irrelevant.
 *
 * Roles under test are the real seeded DEFAULT_ROLES: Customer Support (Support Admin),
 * Operations Admin, Finance Admin, Super Administrator.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("../middlewares/authenticate", async () => {
  const actual = await vi.importActual<typeof import("../middlewares/authenticate")>("../middlewares/authenticate");
  const { AppError } = await import("../shared/errors/app-error");
  return {
    ...actual,
    authenticate(request: any, _res: any, next: any) {
      const header = request.headers.authorization as string | undefined;
      if (!header?.startsWith("Bearer ")) return next(new AppError("Missing token", 401));
      try {
        const p = jwt.verify(header.slice(7), "test-secret-key-for-testing-only") as { sub: string; role: string; email: string };
        request.user = { id: p.sub, role: p.role, email: p.email };
        next();
      } catch {
        next(new AppError("Invalid token", 401));
      }
    },
  };
});
// 2FA is covered by its own tests; here it must not mask authorization results.
vi.mock("../middlewares/require-2fa", () => ({ require2fa: async (_req: any, _res: any, next: any) => { next(); } }));

import request from "supertest";
import type { Express } from "express";
import { generateTestToken } from "./helpers";
import { DEFAULT_ROLES, adminRolesService } from "../modules/admin/admin-roles.service";

let app: Express;
const permsOf = (roleName: string): string[] => {
  const role = DEFAULT_ROLES.find((r) => r.name === roleName);
  if (!role) throw new Error(`role ${roleName} missing`);
  return [...role.permissions];
};
const USERS: Record<string, string[]> = {
  support: permsOf("Customer Support"),
  ops: permsOf("Operations Admin"),
  finance: permsOf("Finance Admin"),
  super: permsOf("Super Administrator"),
};
const token = (who: keyof typeof USERS) => generateTestToken({ id: `u-${who}`, role: "ADMIN", email: `${who}@t.com` });

beforeAll(async () => {
  app = (await import("../app")).app;
}, 30_000);

beforeEach(() => {
  vi.spyOn(adminRolesService, "userPermissions").mockImplementation(async (userId: string) => USERS[userId.replace("u-", "")] ?? []);
});

async function call(method: "get" | "post" | "patch" | "put", path: string, who: keyof typeof USERS, body: object = {}) {
  return (request(app) as any)[method](path).set("Authorization", `Bearer ${token(who)}`).send(body);
}

describe("Community Buy payment enablement is Super Administrator only", () => {
  const enable = { enabled: true, reason: "Approved after readiness review", approvalReference: "APR-1" };

  for (const who of ["support", "ops", "finance"] as const) {
    it(`${who}: POST markets/:id/payments (enable) -> 403`, async () => {
      const res = await call("post", "/api/admin/community-buy/markets/AT/payments", who, enable);
      expect(res.status).toBe(403);
    });
    it(`${who}: PATCH markets/:id/readiness -> 403`, async () => {
      const res = await call("patch", "/api/admin/community-buy/markets/AT/readiness", who, { reason: "Recording evidence", providerSupported: true });
      expect(res.status).toBe(403);
    });
  }

  it("super admin passes the authorization gate (any later outcome is not an auth failure)", async () => {
    const res = await call("post", "/api/admin/community-buy/markets/AT/payments", "super", enable);
    expect([401, 403]).not.toContain(res.status);
  });
});

describe("role boundaries on money / settings / roles / audit export", () => {
  const cases: Array<{ name: string; method: "get" | "post" | "patch" | "put"; path: string; allowed: string[]; denyOnly?: boolean }> = [
    { name: "refund an order", method: "post", path: "/api/admin/orders/o1/refund", allowed: ["finance", "super"] },
    { name: "approve a payout", method: "patch", path: "/api/admin/payout-requests/p1/approve", allowed: ["finance", "super"] },
    // allowed roles reach a DB read first (no DB in unit env): only the denial side is asserted here.
    { name: "mark payout paid", method: "patch", path: "/api/admin/payout-requests/p1/mark-paid", allowed: ["finance", "super"], denyOnly: true },
    { name: "suspend a user", method: "patch", path: "/api/admin/users/x/suspend", allowed: ["ops", "super"] },
    { name: "suspend a vendor", method: "patch", path: "/api/admin/vendors/x/suspend", allowed: ["ops", "super"] },
    { name: "close a vendor", method: "post", path: "/api/admin/vendors/x/close", allowed: ["ops", "super"] },
    { name: "invite an admin", method: "post", path: "/api/admin/admins/invite", allowed: ["super"] },
    { name: "assign a role", method: "post", path: "/api/admin/roles/r1/assignments", allowed: ["super"] },
    { name: "write a platform flag", method: "put", path: "/api/admin/settings/flags/FLAG_X", allowed: ["super"] },
    { name: "export audit log", method: "get", path: "/api/admin/audit-logs/export", allowed: ["super", "finance"] },
    { name: "broadcast a message", method: "post", path: "/api/admin/broadcasts", allowed: ["support", "ops", "super"] },
    { name: "automation emergency stop", method: "post", path: "/api/admin/automation/emergency-stop", allowed: ["super"] },
    { name: "subscription admin cancel", method: "post", path: "/api/admin/subscriptions/s1/force-cancel", allowed: ["ops", "super"] },
    { name: "unpublish a product", method: "post", path: "/api/admin/products/p1/unpublish", allowed: ["ops", "super"] },
    { name: "cancel a gift card", method: "post", path: "/api/admin/gift-cards/purchased/g1/cancel", allowed: ["ops", "super"] },
  ];

  for (const c of cases) {
    for (const who of ["support", "ops", "finance", "super"] as const) {
      const shouldPass = c.allowed.includes(who);
      if (shouldPass && c.denyOnly) continue;
      it(`${who} ${shouldPass ? "may" : "may NOT"} ${c.name}`, async () => {
        const res = await call(c.method, c.path, who, { reason: "Matrix test reason", enabled: true });
        if (shouldPass) {
          expect(res.body?.code).not.toBe("ADMIN_PERMISSION_DENIED");
          expect(res.status).not.toBe(401);
        } else {
          expect(res.status).toBe(403);
          expect(res.body?.code).toBe("ADMIN_PERMISSION_DENIED");
        }
      });
    }
  }

  it("a user with no admin role assignment has zero permissions", async () => {
    vi.spyOn(adminRolesService, "userPermissions").mockResolvedValue([]);
    const res = await call("get", "/api/admin/users", "support");
    expect(res.status).toBe(403);
  });

  it("an unauthenticated request is 401, a buyer token is 403", async () => {
    expect((await request(app).get("/api/admin/users")).status).toBe(401);
    const buyer = generateTestToken({ id: "b1", role: "BUYER", email: "b@t.com" });
    expect((await request(app).get("/api/admin/users").set("Authorization", `Bearer ${buyer}`)).status).toBe(403);
  });
});
