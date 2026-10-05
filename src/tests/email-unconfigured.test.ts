/**
 * An unconfigured email provider must never be reported as "sent" in
 * production (B16: lib/email.ts used to return true).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const original = { key: process.env.RESEND_API_KEY, env: process.env.NODE_ENV };

async function load() {
  vi.resetModules();
  return import("../lib/email");
}

afterEach(() => {
  if (original.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = original.key;
  process.env.NODE_ENV = original.env;
});

describe("sendEmail with no provider configured", () => {
  it("returns false and error 'not_configured' in production", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.NODE_ENV = "production";
    const email = await load();
    expect(email.isEmailEnabled()).toBe(false);
    expect(await email.sendEmail({ to: "a@b.c", subject: "s", html: "h" })).toBe(false);
    expect(await email.sendEmailDetailed({ to: "a@b.c", subject: "s", html: "h" })).toEqual({ ok: false, error: "not_configured" });
  });

  it("keeps the dev/test convenience (log only, returns true) outside production", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.NODE_ENV = "test";
    const email = await load();
    expect(await email.sendEmail({ to: "a@b.c", subject: "s", html: "h" })).toBe(true);
  });
});
