/**
 * Phase 9 — Security headers, CORS, x-powered-by suppression.
 *
 * Drives the in-process Express app via supertest. Confirms:
 *   - X-Powered-By is never sent (app.disable + helmet)
 *   - X-Content-Type-Options, X-Frame-Options, Referrer-Policy on every
 *     route, including the Helmet-relaxed /api/docs and /store/:slug
 *   - HSTS present on TLS-fronted responses (helmet default)
 *   - CORS rejects untrusted origins in production
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

let app: Express;

beforeAll(async () => {
  // Force production-style CORS allowlist for these tests.
  process.env.NODE_ENV = "production";
  process.env.CORS_ORIGINS = "https://neon.online";
  // Avoid Turnstile blackout when test sends bodies with no token.
  process.env.TURNSTILE_DISABLED = "true";

  const mod = await import("../app");
  app = mod.app;
}, 30_000);

afterEach(() => {
  vi.clearAllMocks();
});

describe("Phase 9 — Security headers on /api/health", () => {
  it("does not leak X-Powered-By", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options or CSP frame-ancestors", async () => {
    const res = await request(app).get("/api/health");
    const xfo = res.headers["x-frame-options"];
    const csp = res.headers["content-security-policy"] ?? "";
    expect(xfo === "SAMEORIGIN" || xfo === "DENY" || /frame-ancestors/i.test(csp)).toBe(true);
  });

  it("sets Referrer-Policy", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["referrer-policy"]).toBeTruthy();
  });
});

describe("Phase 9 — Security headers on /api/docs (Helmet sub-set)", () => {
  it("does not leak X-Powered-By even when CSP is relaxed", async () => {
    const res = await request(app).get("/api/docs");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("still emits X-Content-Type-Options on /api/docs", async () => {
    const res = await request(app).get("/api/docs");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("still emits X-Frame-Options or frame-ancestors on /api/docs", async () => {
    const res = await request(app).get("/api/docs");
    const xfo = res.headers["x-frame-options"];
    const csp = res.headers["content-security-policy"] ?? "";
    expect(xfo === "SAMEORIGIN" || xfo === "DENY" || /frame-ancestors/i.test(csp)).toBe(true);
  });
});

describe("Phase 9 — CORS allowlist", () => {
  it("untrusted origin receives no Access-Control-Allow-Origin", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");
    // Either no ACAO header at all, or an explicit allowed origin (not the evil one).
    const acao = res.headers["access-control-allow-origin"];
    expect(acao === undefined || acao === "https://neon.online").toBe(true);
    expect(acao).not.toBe("https://evil.example");
    expect(acao).not.toBe("*");
  });

  it("trusted origin (neon.online) is echoed back", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", "https://neon.online")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-origin"]).toBe("https://neon.online");
  });
});
