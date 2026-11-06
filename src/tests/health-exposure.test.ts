import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  balance: vi.fn(),
  sentryEnabled: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({ prisma: { $queryRaw: m.queryRaw } }));
vi.mock("../lib/stripe", () => ({ stripe: { balance: { retrieve: m.balance } } }));
vi.mock("../lib/paystack", () => ({ paystack: { isConfigured: () => false } }));
vi.mock("../lib/sentry", () => ({ isSentryEnabled: m.sentryEnabled }));
vi.mock("../lib/storage", () => ({ isStorageConfigured: () => true }));

import { getHealthDetailed, sentryTest } from "../modules/health/health.controller";

const SECRET = "local-health-test-value";

function call(headers: Record<string, string> = {}) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return { req: { headers } as unknown as Request, res: res as unknown as Response, spy: res };
}

let now = Date.parse("2026-11-06T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  // Each test starts past the previous test's cached result.
  now += 10 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  process.env.CRON_SECRET = SECRET;
  m.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  m.balance.mockResolvedValue({});
  m.sentryEnabled.mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GET /health/detailed", () => {
  it("gives anonymous callers statuses only when a dependency fails", async () => {
    m.queryRaw.mockRejectedValue(new Error("postgres://internal-host connection refused"));
    const { req, res, spy } = call();

    await getHealthDetailed(req, res);

    expect(spy.status).toHaveBeenCalledWith(503);
    const body = spy.json.mock.calls[0][0];
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toEqual({ status: "error" });
    expect(JSON.stringify(body)).not.toContain("internal-host");
  });

  it("does not tell anonymous callers the Stripe mode", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    const { req, res, spy } = call();

    await getHealthDetailed(req, res);

    expect(spy.status).toHaveBeenCalledWith(200);
    expect(spy.json.mock.calls[0][0].checks.stripe).toEqual({ status: "ok" });
  });

  it("does not repeat Stripe calls for repeated anonymous requests", async () => {
    for (let i = 0; i < 5; i += 1) {
      const { req, res } = call();
      await getHealthDetailed(req, res);
    }
    expect(m.balance).toHaveBeenCalledTimes(1);
  });

  it("checks again once the cache expires", async () => {
    const first = call();
    await getHealthDetailed(first.req, first.res);

    vi.setSystemTime(now + 61_000);
    const second = call();
    await getHealthDetailed(second.req, second.res);

    expect(m.balance).toHaveBeenCalledTimes(2);
  });

  it("gives a wrong secret the anonymous view", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    const { req, res, spy } = call({ authorization: "Bearer wrong-value" });

    await getHealthDetailed(req, res);

    expect(spy.json.mock.calls[0][0].checks.stripe.detail).toBeUndefined();
  });

  it("gives anonymous callers no detail when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    const { req, res, spy } = call({ authorization: "Bearer " });

    await getHealthDetailed(req, res);

    expect(spy.json.mock.calls[0][0].checks.stripe.detail).toBeUndefined();
  });

  it("gives the cron secret a fresh, full report", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    const anonymous = call();
    await getHealthDetailed(anonymous.req, anonymous.res);

    const { req, res, spy } = call({ authorization: `Bearer ${SECRET}` });
    await getHealthDetailed(req, res);

    expect(m.balance).toHaveBeenCalledTimes(2);
    expect(spy.json.mock.calls[0][0].checks.stripe.detail).toBe("test");
  });
});

describe("GET /health/sentry-test", () => {
  it("refuses anonymous callers and raises nothing", () => {
    const { req, res, spy } = call();

    expect(() => sentryTest(req, res)).not.toThrow();

    expect(spy.status).toHaveBeenCalledWith(401);
  });

  it("raises the test error for the cron secret", () => {
    const { req, res } = call({ "x-job-secret": SECRET });

    expect(() => sentryTest(req, res)).toThrow("[Sentry Test]");
  });
});
