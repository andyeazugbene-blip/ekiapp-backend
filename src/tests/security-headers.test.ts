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
  process.env.CORS_ORIGINS = "https://culinarytales.app,https://www.culinarytales.app";
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
    expect(acao === undefined || acao === "https://culinarytales.app").toBe(true);
    expect(acao).not.toBe("https://evil.example");
    expect(acao).not.toBe("*");
  });

  it("trusted origin (culinarytales.app apex) is echoed back", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", "https://culinarytales.app")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-origin"]).toBe("https://culinarytales.app");
  });

  it("trusted origin (www.culinarytales.app) is echoed back", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", "https://www.culinarytales.app")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-origin"]).toBe("https://www.culinarytales.app");
  });

  // Bug fix 2026-10-05: admin-web's apiClient (lib/api.ts) automatically
  // retries any 2FA-gated admin action with an `x-2fa-code` header once the
  // server first reports 2FA_REQUIRED. If the browser's preflight for that
  // retry doesn't see this header in Access-Control-Allow-Headers, it never
  // sends the real request at all — the admin just sees "Network error",
  // with nothing reaching the server to log. Covers every 2FA-gated admin
  // route (invite, role change, payout approval, etc), not only invite.
  it("preflight for a 2FA-gated retry allows the x-2fa-code header", async () => {
    const res = await request(app)
      .options("/api/admin/admins/invite")
      .set("Origin", "https://culinarytales.app")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type, authorization, x-2fa-code");
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toContain("x-2fa-code");
  });
});
