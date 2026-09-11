/**
 * Route-level regression coverage for the Regular Delivery admin
 * endpoints — added after a real device QA bug: production admin-web
 * called the OLD path (/api/admin/subscription-exceptions), which no
 * longer exists (removed in 1435a04 as a dead/unpermissioned duplicate
 * of the real endpoint, /api/admin/subscriptions/exceptions). The route
 * itself was never wrong; a stale admin-web deployment was still calling
 * it. This file locks down the exact real path and its auth/permission
 * gating through the actual Express router, the layer no unit test on
 * the service alone can catch.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const mockAssertPermission = vi.fn().mockResolvedValue(undefined);
vi.mock("../modules/admin/admin-roles.service", async () => {
  const actual = await vi.importActual<typeof import("../modules/admin/admin-roles.service")>(
    "../modules/admin/admin-roles.service",
  );
  return {
    ...actual,
    adminRolesService: {
      ...actual.adminRolesService,
      assertPermission: (...a: unknown[]) => mockAssertPermission(...a),
    },
  };
});

const mockRenewalFindMany = vi.fn().mockResolvedValue([]);
vi.mock("../lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../lib/prisma")>("../lib/prisma");
  return {
    prisma: new Proxy(actual.prisma, {
      get(target, prop) {
        if (prop === "renewal") return { findMany: (...a: unknown[]) => mockRenewalFindMany(...a) };
        return (target as any)[prop];
      },
    }),
  };
});

vi.mock("../middlewares/authenticate", async () => {
  const actual = await vi.importActual<typeof import("../middlewares/authenticate")>(
    "../middlewares/authenticate",
  );
  const { AppError } = await import("../shared/errors/app-error");
  return {
    ...actual,
    authenticate(request: any, _res: any, next: any) {
      const header = request.headers.authorization as string | undefined;
      if (!header || !header.startsWith("Bearer ")) {
        next(new AppError("Missing or invalid Authorization header", 401));
        return;
      }
      try {
        const payload = jwt.verify(header.slice(7), "test-secret-key-for-testing-only") as {
          sub: string;
          role: "BUYER" | "VENDOR" | "ADMIN";
          email: string;
        };
        request.user = { id: payload.sub, role: payload.role, email: payload.email };
        next();
      } catch {
        next(new AppError("Invalid token", 401));
      }
    },
  };
});

import request from "supertest";
import type { Express } from "express";
import { generateTestToken } from "./helpers";
import { AppError } from "../shared/errors/app-error";

let app: Express;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.app;
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertPermission.mockResolvedValue(undefined);
  mockRenewalFindMany.mockResolvedValue([]);
});

const adminToken = () => generateTestToken({ id: "admin-1", role: "ADMIN", email: "admin@eki.app" });

describe("Admin Regular Delivery exception queue — real route path", () => {
  it("GET /api/admin/subscriptions/exceptions (the real, current path) reaches the handler for an authorized admin", async () => {
    const res = await request(app).get("/api/admin/subscriptions/exceptions").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockRenewalFindMany).toHaveBeenCalled();
  });

  it("GET /api/admin/subscriptions/exceptions requires authentication — no token gives 401", async () => {
    const res = await request(app).get("/api/admin/subscriptions/exceptions");
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/subscriptions/exceptions checks the real admin permission (orders.read) — asserted before the handler runs", async () => {
    await request(app).get("/api/admin/subscriptions/exceptions").set("Authorization", `Bearer ${adminToken()}`);
    expect(mockAssertPermission).toHaveBeenCalledWith("admin-1", "orders.read");
  });

  it("GET /api/admin/subscriptions/exceptions returns 403, not the handler's data, when the admin lacks the permission", async () => {
    mockAssertPermission.mockRejectedValue(new AppError("Forbidden", 403));
    const res = await request(app).get("/api/admin/subscriptions/exceptions").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(403);
    expect(mockRenewalFindMany).not.toHaveBeenCalled();
  });

  it("the OLD, removed path (/api/admin/subscription-exceptions, hyphenated) no longer exists — regression guard against re-adding a duplicate route", async () => {
    const res = await request(app).get("/api/admin/subscription-exceptions").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });

  it("POST /api/admin/subscriptions/:id/retry-payment requires the orders.mutate permission", async () => {
    mockAssertPermission.mockRejectedValue(new AppError("Forbidden", 403));
    const res = await request(app).post("/api/admin/subscriptions/renewal-1/retry-payment").set("Authorization", `Bearer ${adminToken()}`).send({});
    expect(res.status).toBe(403);
    expect(mockAssertPermission).toHaveBeenCalledWith("admin-1", "orders.mutate");
  });

  it("a non-admin role (VENDOR) is rejected before reaching the permission check at all", async () => {
    const vendorToken = generateTestToken({ id: "vendor-1", role: "VENDOR", email: "vendor@eki.app" });
    const res = await request(app).get("/api/admin/subscriptions/exceptions").set("Authorization", `Bearer ${vendorToken}`);
    expect(res.status).toBe(403);
    expect(mockAssertPermission).not.toHaveBeenCalled();
  });
});
