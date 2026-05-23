import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Turnstile Middleware", () => {
  let requireTurnstile: (req: Request, res: Response, next: NextFunction) => void;

  function createMockReq(body: Record<string, unknown> = {}, ip = "127.0.0.1"): Request {
    return { body, ip } as unknown as Request;
  }

  function createMockRes(): Response {
    return {} as unknown as Response;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockFetch.mockReset();
  });

  it("should skip validation in development when TURNSTILE_SECRET_KEY is not set", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const mod = await import("../middlewares/turnstile");
    requireTurnstile = mod.requireTurnstile;

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("should skip validation in test environment when key is not set", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const mod = await import("../middlewares/turnstile");
    requireTurnstile = mod.requireTurnstile;

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("should reject in production when TURNSTILE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const mod = await import("../middlewares/turnstile");
    requireTurnstile = mod.requireTurnstile;

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503 }));
  });

  it("should reject when cf-turnstile-response is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");

    const mod = await import("../middlewares/turnstile");
    requireTurnstile = mod.requireTurnstile;

    const next = vi.fn();
    requireTurnstile(createMockReq({}), createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it("should reject when captcha verification fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");

    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });

    const mod = await import("../middlewares/turnstile");
    requireTurnstile = mod.requireTurnstile;

    const next = vi.fn();
    requireTurnstile(
      createMockReq({ "cf-turnstile-response": "bad-token" }),
      createMockRes(),
      next,
    );

    // Wait for async verification
    await new Promise((r) => setTimeout(r, 10));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("should pass when captcha verification succeeds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");

    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const mod = await import("../middlewares/turnstile");
    requireTurnstile = mod.requireTurnstile;

    const next = vi.fn();
    requireTurnstile(
      createMockReq({ "cf-turnstile-response": "valid-token" }),
      createMockRes(),
      next,
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(next).toHaveBeenCalledWith();
  });

  it("should skip when TURNSTILE_DISABLED=true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "true");

    const mod = await import("../middlewares/turnstile");
    requireTurnstile = mod.requireTurnstile;

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});
