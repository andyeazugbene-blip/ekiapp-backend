import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { paystack } from "../../lib/paystack";
import { isSentryEnabled } from "../../lib/sentry";
import { isStorageConfigured } from "../../lib/storage";
import { constantTimeEqual } from "../../shared/utils/crypto";

type HealthCheck = { status: "ok" | "error" | "skipped"; latencyMs?: number; detail?: string };
type HealthReport = { critical: boolean; overall: "ok" | "degraded"; checks: Record<string, HealthCheck> };

const ANONYMOUS_CACHE_MS = 60_000;
let anonymousCache: { expiresAt: number; report: Promise<HealthReport> } | null = null;

/** Same secret and headers as the internal job routes. */
function hasOperatorAccess(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const jobSecret = request.headers["x-job-secret"];
  return (
    (typeof bearer === "string" && constantTimeEqual(bearer, secret)) ||
    (typeof jobSecret === "string" && constantTimeEqual(jobSecret, secret))
  );
}

export function getHealth(_request: Request, response: Response): void {
  response.status(200).json({ status: "ok" });
}

/**
 * GET /api/health/sentry-test
 * Triggers a safe test error to verify Sentry is capturing exceptions.
 * Needs the cron secret, so the public can't fill Sentry with test errors.
 */
export function sentryTest(_request: Request, _response: Response): void {
  if (!hasOperatorAccess(_request)) {
    _response.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!isSentryEnabled()) {
    _response.status(200).json({ sentry: "disabled", message: "SENTRY_DSN not configured" });
    return;
  }

  // Throw a controlled error that the error handler will catch and send to Sentry
  throw new Error("[Sentry Test] Verification error — safe to ignore");
}

/**
 * Detailed health check — verifies all critical dependencies.
 * Returns 200 if all critical checks pass, 503 if any fail.
 *
 * Anonymous callers, such as uptime monitors, get each check's status from a
 * short cache: no error text, Stripe mode or latency, and no way to drive
 * Stripe calls by repeating the request. The cron secret gets a fresh, full report.
 */
export async function getHealthDetailed(request: Request, response: Response): Promise<void> {
  if (hasOperatorAccess(request)) {
    const report = await runHealthChecks();
    response.status(report.critical ? 200 : 503).json({ status: report.overall, checks: report.checks });
    return;
  }

  if (!anonymousCache || anonymousCache.expiresAt <= Date.now()) {
    anonymousCache = { expiresAt: Date.now() + ANONYMOUS_CACHE_MS, report: runHealthChecks() };
  }
  const report = await anonymousCache.report;
  const checks = Object.fromEntries(
    Object.entries(report.checks).map(([name, check]) => [name, { status: check.status }]),
  );
  response.status(report.critical ? 200 : 503).json({ status: report.overall, checks });
}

async function runHealthChecks(): Promise<HealthReport> {
  const checks: Record<string, HealthCheck> = {};

  // Database
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
  } catch (error) {
    checks.database = { status: "error", latencyMs: Date.now() - dbStart, detail: error instanceof Error ? error.message : String(error) };
  }

  // Stripe via SDK
  const stripeStart = Date.now();
  try {
    await stripe.balance.retrieve();
    const stripeMode = process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")
      ? "live"
      : process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
        ? "test"
        : "unknown";
    checks.stripe = { status: "ok", latencyMs: Date.now() - stripeStart, detail: stripeMode };
  } catch (error) {
    checks.stripe = { status: "error", latencyMs: Date.now() - stripeStart, detail: error instanceof Error ? error.message : String(error) };
  }

  // Raw Stripe connection test (bypass SDK)
  const rawStripeStart = Date.now();
  try {
    const rawRes = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    checks.stripe_raw = { status: rawRes.ok ? "ok" : "error", latencyMs: Date.now() - rawStripeStart, detail: rawRes.ok ? "raw fetch works" : `HTTP ${rawRes.status}: ${await rawRes.text().catch(() => "no body")}` };
  } catch (error) {
    checks.stripe_raw = { status: "error", latencyMs: Date.now() - rawStripeStart, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }

  // Connect, read-only: a connected account proves Connect works. This list also comes
  // back empty on an account without Connect, so an empty list proves nothing and isn't
  // reported as ok. It creates nothing and moves no money.
  const connectStart = Date.now();
  try {
    const accounts = await stripe.accounts.list({ limit: 1 });
    checks.stripe_connect = accounts.data.length > 0
      ? { status: "ok", latencyMs: Date.now() - connectStart, detail: "Connect active: connected accounts exist" }
      : { status: "skipped", latencyMs: Date.now() - connectStart, detail: "Not confirmed: no connected accounts yet" };
  } catch (error) {
    checks.stripe_connect = { status: "error", latencyMs: Date.now() - connectStart, detail: error instanceof Error ? error.message : String(error) };
  }

  // Paystack (optional — only check if configured)
  if (paystack.isConfigured()) {
    const psStart = Date.now();
    try {
      // Simple connectivity check — verify API responds
      const res = await fetch("https://api.paystack.co/bank?currency=NGN&perPage=1", {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      });
      checks.paystack = { status: res.ok ? "ok" : "error", latencyMs: Date.now() - psStart };
    } catch (error) {
      checks.paystack = { status: "error", latencyMs: Date.now() - psStart, detail: error instanceof Error ? error.message : String(error) };
    }
  } else {
    checks.paystack = { status: "skipped", detail: "PAYSTACK_SECRET_KEY not configured" };
  }

  checks.storage = isStorageConfigured()
    ? { status: "ok" }
    : { status: "error", detail: "S3-compatible storage is not configured" };

  // Critical = database + stripe + storage
  const critical =
    checks.database.status === "ok" &&
    checks.stripe.status === "ok" &&
    checks.storage.status === "ok";
  const overall = critical ? "ok" : "degraded";

  return { critical, overall, checks };
}
