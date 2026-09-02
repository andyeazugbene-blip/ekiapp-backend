/**
 * Controller/HTTP-level tests for the Automation Engine routes.
 *
 * Service-only tests can't catch a broken route wiring (wrong path, missing
 * middleware, a param helper that recurses instead of reading
 * request.params — see regular-deliveries.controller.ts's earlier bug).
 * These tests go through the real Express router + real requireRole
 * middleware, with only the service layer and auth token verification
 * mocked out, so a wiring mistake here fails a test instead of shipping.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const mockListVendorAutomations = vi.fn();
const mockSetVendorAutomation = vi.fn();
const mockListVendorActivity = vi.fn();
const mockAdminSummary = vi.fn();

vi.mock("../modules/automation/automation.service", () => ({
  automationService: {
    listVendorAutomations: (...args: unknown[]) => mockListVendorAutomations(...args),
    setVendorAutomation: (...args: unknown[]) => mockSetVendorAutomation(...args),
    listVendorActivity: (...args: unknown[]) => mockListVendorActivity(...args),
    adminSummary: (...args: unknown[]) => mockAdminSummary(...args),
  },
  CONFIGURABLE_TYPES: new Set(["CART_RECOVERY", "BUYER_WIN_BACK"]),
  DEFAULT_CONFIG: { CART_RECOVERY: { reminderHours: 2 }, BUYER_WIN_BACK: { inactivityDays: 45 } },
}));

const mockVendorFindUnique = vi.fn();
vi.mock("../lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../lib/prisma")>("../lib/prisma");
  return {
    prisma: new Proxy(actual.prisma, {
      get(target, prop) {
        if (prop === "vendor") {
          return { findUnique: (...args: unknown[]) => mockVendorFindUnique(...args) };
        }
        return (target as any)[prop];
      },
    }),
  };
});

vi.mock("../modules/admin/admin-roles.service", () => ({
  adminRolesService: {
    assertPermission: vi.fn().mockResolvedValue(undefined),
  },
}));

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
        const token = header.slice(7);
        const payload = jwt.verify(token, "test-secret-key-for-testing-only") as {
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

let app: Express;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.app;
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockVendorFindUnique.mockResolvedValue({ id: "vendor-db-1" });
  mockListVendorAutomations.mockResolvedValue([{ type: "FIRST_SALE", enabled: true, description: "..." }]);
  mockSetVendorAutomation.mockResolvedValue({ id: "s1", vendorId: "vendor-db-1", type: "FIRST_SALE", enabled: false });
  mockListVendorActivity.mockResolvedValue([]);
  mockAdminSummary.mockResolvedValue({ byType: [], byStatus: [], recentFailures: [] });
});

const vendorToken = () => generateTestToken({ id: "vendor-user-1", role: "VENDOR", email: "v@x.com" });
const buyerToken = () => generateTestToken({ id: "buyer-1", role: "BUYER", email: "b@x.com" });
const adminToken = () => generateTestToken({ id: "admin-1", role: "ADMIN", email: "a@x.com" });

describe("Automation routes — auth/role gating", () => {
  it("GET /api/vendor/automations — 401 without token", async () => {
    const res = await request(app).get("/api/vendor/automations");
    expect(res.status).toBe(401);
    expect(mockListVendorAutomations).not.toHaveBeenCalled();
  });

  it("GET /api/vendor/automations — 403 for a buyer token", async () => {
    const res = await request(app).get("/api/vendor/automations").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(403);
    expect(mockListVendorAutomations).not.toHaveBeenCalled();
  });

  it("GET /api/vendor/automations — 200 for a vendor token, resolves vendor id from the user, not the JWT", async () => {
    const res = await request(app).get("/api/vendor/automations").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(mockVendorFindUnique).toHaveBeenCalledWith({ where: { userId: "vendor-user-1" }, select: { id: true } });
    expect(mockListVendorAutomations).toHaveBeenCalledWith("vendor-db-1");
  });

  it("GET /api/vendor/automations — 403 when the authenticated user has no vendor profile", async () => {
    mockVendorFindUnique.mockResolvedValue(null);
    const res = await request(app).get("/api/vendor/automations").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(403);
  });
});

describe("Automation routes — PATCH :id param handling", () => {
  // Regression guard: the earlier bug in a sibling module was a param
  // helper that called itself instead of reading request.params.id. A
  // real HTTP request through the real router is the only thing that
  // actually exercises Express's param parsing, so it's the only test
  // that would have caught it.
  it("PATCH /api/vendor/automations/:id — reads the id from the URL and forwards it + body to the service", async () => {
    const res = await request(app)
      .patch("/api/vendor/automations/CART_RECOVERY")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(mockSetVendorAutomation).toHaveBeenCalledWith("vendor-db-1", "CART_RECOVERY", false);
  });

  it("PATCH /api/vendor/automations/:id — 400 for an unknown automation type", async () => {
    const res = await request(app)
      .patch("/api/vendor/automations/NOT_A_REAL_TYPE")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(mockSetVendorAutomation).not.toHaveBeenCalled();
  });

  it("PATCH /api/vendor/automations/:id — 400 when enabled is not a boolean", async () => {
    const res = await request(app)
      .patch("/api/vendor/automations/CART_RECOVERY")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ enabled: "false" });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/vendor/automations/:id — forwards a valid config for a configurable type", async () => {
    const res = await request(app)
      .patch("/api/vendor/automations/CART_RECOVERY")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ enabled: true, config: { reminderHours: 24 } });
    expect(res.status).toBe(200);
    expect(mockSetVendorAutomation).toHaveBeenCalledWith("vendor-db-1", "CART_RECOVERY", true, { reminderHours: 24 });
  });

  it("PATCH /api/vendor/automations/:id — 400 when a config value is not a positive number", async () => {
    const res = await request(app)
      .patch("/api/vendor/automations/BUYER_WIN_BACK")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ enabled: true, config: { inactivityDays: 0 } });
    expect(res.status).toBe(400);
    expect(mockSetVendorAutomation).not.toHaveBeenCalled();
  });

  it("PATCH /api/vendor/automations/:id — ignores a config payload for a non-configurable type", async () => {
    const res = await request(app)
      .patch("/api/vendor/automations/FIRST_SALE")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ enabled: true, config: { anything: 5 } });
    expect(res.status).toBe(200);
    expect(mockSetVendorAutomation).toHaveBeenCalledWith("vendor-db-1", "FIRST_SALE", true);
  });
});

describe("Automation routes — activity + admin summary", () => {
  it("GET /api/vendor/automations/activity — 200, forwards limit query param", async () => {
    const res = await request(app)
      .get("/api/vendor/automations/activity?limit=10")
      .set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockListVendorActivity).toHaveBeenCalledWith("vendor-db-1", 10);
  });

  it("GET /api/admin/automation/summary — 401 without token", async () => {
    const res = await request(app).get("/api/admin/automation/summary");
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/automation/summary — 200 for an admin token", async () => {
    const res = await request(app).get("/api/admin/automation/summary").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockAdminSummary).toHaveBeenCalledTimes(1);
  });
});
