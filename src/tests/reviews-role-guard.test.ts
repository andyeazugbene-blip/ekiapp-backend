/**
 * Verifies role/auth gating on the reviews routes:
 *   - POST /api/reviews requires authentication (401) and BUYER role (403 for VENDOR/ADMIN)
 *   - GET  /api/reviews is public (no token required)
 *   - GET  /api/reviews/me requires authentication (401)
 *
 * Service is mocked so the test focuses only on the middleware chain.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const mockCreate = vi.fn();
const mockListPublic = vi.fn();
const mockListMy = vi.fn();

vi.mock("../modules/reviews/reviews.service", () => ({
  reviewsService: {
    createReview: (...args: unknown[]) => mockCreate(...args),
    listPublicReviews: (...args: unknown[]) => mockListPublic(...args),
    listMyReviews: (...args: unknown[]) => mockListMy(...args),
  },
}));

// Stub the authenticate middleware: read role/sub straight from a fake token
// to avoid hitting the database. We still want requireRole to run unmodified.
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
      } catch (e) {
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
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ id: "r1", rating: 5, status: "PENDING" });
  mockListPublic.mockReset();
  mockListPublic.mockResolvedValue({ items: [], nextCursor: null, averageRating: null, totalReviews: 0 });
  mockListMy.mockReset();
  mockListMy.mockResolvedValue({ items: [], nextCursor: null });
});

const buyerToken = () => generateTestToken({ id: "buyer-1", role: "BUYER", email: "b@x.com" });
const vendorToken = () => generateTestToken({ id: "vendor-1", role: "VENDOR", email: "v@x.com" });
const adminToken = () => generateTestToken({ id: "admin-1", role: "ADMIN", email: "a@x.com" });

const validBody = {
  orderId: "o1",
  vendorId: "v1",
  productId: "p1",
  rating: 5,
};

describe("Reviews route role enforcement", () => {
  it("POST /api/reviews — 401 when no token", async () => {
    const res = await request(app).post("/api/reviews").send(validBody);
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("POST /api/reviews — 403 for VENDOR role", async () => {
    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send(validBody);
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("POST /api/reviews — 403 for ADMIN role", async () => {
    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send(validBody);
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("POST /api/reviews — 201 for BUYER role with valid body", async () => {
    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("GET /api/reviews — 200 without auth (public)", async () => {
    const res = await request(app).get("/api/reviews?productId=p1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("averageRating");
    expect(res.body).toHaveProperty("totalReviews");
    expect(mockListPublic).toHaveBeenCalledTimes(1);
  });

  it("GET /api/reviews/me — 401 without token", async () => {
    const res = await request(app).get("/api/reviews/me");
    expect(res.status).toBe(401);
  });

  it("GET /api/reviews/me — 200 for any authenticated user", async () => {
    const res = await request(app)
      .get("/api/reviews/me")
      .set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
  });
});
