/**
 * Integration tests for POST /api/auth/register with Turnstile gating.
 *
 * These tests exercise the real Express router + middleware chain end-to-end.
 * authService.register is mocked so the test does not require a database.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";

// Mock the auth service so register doesn't hit the database.
// `register` returns a deterministic shape so we can assert pass-through.
const mockRegister = vi.fn();
vi.mock("../modules/auth/auth.service", () => ({
  authService: {
    register: (...args: unknown[]) => mockRegister(...args),
  },
}));

// Mock fetch for Turnstile verification
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import request from "supertest";
import type { Express } from "express";

let app: Express;

beforeAll(async () => {
  // Import app after mocks are registered. Bootstrap can take several seconds
  // because it loads Prisma, Stripe, Resend, swagger, and all routers.
  const mod = await import("../app");
  app = mod.app;
}, 30_000);

beforeEach(() => {
  mockFetch.mockReset();
  mockRegister.mockReset();
  mockRegister.mockResolvedValue({
    user: { id: "u1", email: "test@example.com", name: "Test", role: "BUYER" },
    token: "fake.jwt.token",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const VALID_BODY = {
  email: "round5-register@example.com",
  password: "Password1",
  name: "Round Five",
};

describe("POST /api/auth/register — Turnstile gating", () => {
  it("returns 400 with TURNSTILE_TOKEN_MISSING when token absent in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    const res = await request(app).post("/api/auth/register").send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Turnstile token required");
    expect(res.body.code).toBe("TURNSTILE_TOKEN_MISSING");
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("returns 403 with TURNSTILE_INVALID_TOKEN when Cloudflare rejects the token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });

    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...VALID_BODY, "cf-turnstile-response": "bad-token" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TURNSTILE_INVALID_TOKEN");
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("returns 503 with TURNSTILE_NOT_CONFIGURED when secret missing in production (NOT generic 503)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    const res = await request(app).post("/api/auth/register").send(VALID_BODY);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("TURNSTILE_NOT_CONFIGURED");
    expect(res.body.message).toContain("Captcha is not configured");
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("returns 201 when TURNSTILE_DISABLED=true (operator escape hatch)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("TURNSTILE_DISABLED", "true");

    const res = await request(app).post("/api/auth/register").send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(res.body.token).toBe("fake.jwt.token");
  });

  it("returns 201 when valid Turnstile token is accepted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    mockFetch.mockResolvedValueOnce({ json: async () => ({ success: true }) });

    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...VALID_BODY, "cf-turnstile-response": "valid-token" });

    expect(res.status).toBe(201);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("returns 503 with TURNSTILE_VERIFY_UNAVAILABLE when Cloudflare network call fails in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...VALID_BODY, "cf-turnstile-response": "any-token" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("TURNSTILE_VERIFY_UNAVAILABLE");
  });

  it("development: skips Turnstile entirely and registers", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const res = await request(app).post("/api/auth/register").send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });
});
