/**
 * Stripe Connect production hardening — route-level coverage for
 * GET /api/admin/community-buy/organisers/:id/stripe-connect/status.
 * Isolates authorization (role gate + permission gate) from the service
 * logic itself, already covered by organiser-stripe-connect.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const mockGetStatusForAdmin = vi.fn();
vi.mock("../modules/community-buy/organiser-stripe-connect.service", () => ({
  organiserStripeConnectService: { getStatusForAdmin: (...a: unknown[]) => mockGetStatusForAdmin(...a) },
}));

const mockAssertPermission = vi.fn();
vi.mock("../modules/admin/admin-roles.service", () => ({
  adminRolesService: { assertPermission: (...a: unknown[]) => mockAssertPermission(...a) },
}));

const mockRecordAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("../shared/utils/audit", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
}));

vi.mock("../middlewares/authenticate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middlewares/authenticate")>();
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
        const payload = jwt.verify(token, "test-secret-key-for-testing-only") as { sub: string; role: string; email: string };
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

beforeEach(async () => {
  vi.clearAllMocks();
  mockAssertPermission.mockResolvedValue(undefined);
  const mod = await import("../app");
  app = mod.app;
}, 30_000);

const adminToken = () => generateTestToken({ id: "admin-1", role: "ADMIN", email: "a@x.com" });
const buyerToken = () => generateTestToken({ id: "buyer-1", role: "BUYER", email: "b@x.com" });

describe("GET /api/admin/community-buy/organisers/:id/stripe-connect/status", () => {
  it("401 without a token", async () => {
    const res = await request(app).get("/api/admin/community-buy/organisers/org-1/stripe-connect/status");
    expect(res.status).toBe(401);
    expect(mockGetStatusForAdmin).not.toHaveBeenCalled();
  });

  it("403 for a non-admin role — never reaches the permission check or the service", async () => {
    const res = await request(app).get("/api/admin/community-buy/organisers/org-1/stripe-connect/status").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(403);
    expect(mockGetStatusForAdmin).not.toHaveBeenCalled();
  });

  it("403 when the admin lacks community_buy.mutate — Verification Reviewer or any role missing that permission", async () => {
    const { AppError } = await import("../shared/errors/app-error");
    mockAssertPermission.mockRejectedValueOnce(new AppError("Admin role does not have permission for this action", 403, null, "ADMIN_PERMISSION_DENIED"));
    const res = await request(app).get("/api/admin/community-buy/organisers/org-1/stripe-connect/status").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(403);
    expect(mockGetStatusForAdmin).not.toHaveBeenCalled();
  });

  it("200 for a properly-authorized admin — id parsed correctly, response and audit shape correct", async () => {
    mockGetStatusForAdmin.mockResolvedValue({
      providerConnectedAccountId: "acct_1", fetchedLive: true, stripeStatusFetchedAt: new Date("2026-01-01T00:00:00.000Z"),
      chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
      stripeRequirementsCurrentlyDue: ["individual.dob.day"], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null,
    });

    const res = await request(app).get("/api/admin/community-buy/organisers/org-42/stripe-connect/status").set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(mockGetStatusForAdmin).toHaveBeenCalledWith("org-42");
    expect(res.body.status.fetchedLive).toBe(true);
    expect(res.body.status.stripeRequirementsCurrentlyDue).toEqual(["individual.dob.day"]);
    // Never leaks a Stripe secret key or anything shaped like one.
    expect(JSON.stringify(res.body)).not.toMatch(/sk_(test|live)_/);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "admin-1",
      action: "community_organiser.stripe_connect_status_refreshed",
      entityId: "org-42",
    }));
  });

  it("propagates a real 404 from the service when the organiser doesn't exist", async () => {
    const { AppError } = await import("../shared/errors/app-error");
    mockGetStatusForAdmin.mockRejectedValue(new AppError("Organiser profile not found", 404));
    const res = await request(app).get("/api/admin/community-buy/organisers/org-missing/stripe-connect/status").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });
});
