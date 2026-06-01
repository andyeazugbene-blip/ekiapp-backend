import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

import { requireTurnstile } from "../middlewares/turnstile";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockReq(
  body: Record<string, unknown> = {},
  ip = "127.0.0.1",
  headers: Record<string, string> = {},
): Request {
  return {
    body,
    ip,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name] ?? undefined;
    },
  } as unknown as Request;
}

function createMockRes(): Response {
  return {} as unknown as Response;
}

describe("Turnstile Middleware (unit)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips validation in development when TURNSTILE_SECRET_KEY is not set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("skips validation in test environment when key is not set", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("returns controlled 503 with TURNSTILE_NOT_CONFIGURED code when key missing in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("TURNSTILE_NOT_CONFIGURED");
  });

  it("returns 400 with TURNSTILE_TOKEN_MISSING when token is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    const next = vi.fn();
    requireTurnstile(createMockReq({}), createMockRes(), next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("TURNSTILE_TOKEN_MISSING");
    expect(err.message).toContain("Turnstile token required");
  });

  it("returns 403 with TURNSTILE_INVALID_TOKEN when Cloudflare rejects the token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });

    const next = vi.fn();
    requireTurnstile(
      createMockReq({ "cf-turnstile-response": "bad-token" }),
      createMockRes(),
      next,
    );

    await new Promise((r) => setTimeout(r, 10));
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("TURNSTILE_INVALID_TOKEN");
  });

  it("calls next() with no error when Cloudflare accepts the token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const next = vi.fn();
    requireTurnstile(
      createMockReq({ "cf-turnstile-response": "valid-token" }),
      createMockRes(),
      next,
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(next).toHaveBeenCalledWith();
  });

  it("skips validation when TURNSTILE_DISABLED=true even in production with no key", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("TURNSTILE_DISABLED", "true");

    const next = vi.fn();
    requireTurnstile(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("skips validation for native mobile app requests in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    const next = vi.fn();
    requireTurnstile(
      createMockReq({}, "127.0.0.1", {
        "x-client-app": "eki-mobile",
        "x-client-platform": "ios",
      }),
      createMockRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 503 with TURNSTILE_VERIFY_UNAVAILABLE on network failure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

    const next = vi.fn();
    requireTurnstile(
      createMockReq({ "cf-turnstile-response": "any-token" }),
      createMockRes(),
      next,
    );

    await new Promise((r) => setTimeout(r, 10));
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("TURNSTILE_VERIFY_UNAVAILABLE");
  });

  it("fails open in development when Cloudflare network call fails", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
    vi.stubEnv("TURNSTILE_DISABLED", "");

    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

    const next = vi.fn();
    requireTurnstile(
      createMockReq({ "cf-turnstile-response": "any-token" }),
      createMockRes(),
      next,
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(next).toHaveBeenCalledWith();
  });
});
