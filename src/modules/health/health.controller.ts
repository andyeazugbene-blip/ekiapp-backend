import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { paystack } from "../../lib/paystack";
import { isSentryEnabled } from "../../lib/sentry";
import { isStorageConfigured } from "../../lib/storage";

export function getHealth(_request: Request, response: Response): void {
  response.status(200).json({ status: "ok" });
}

/**
 * GET /api/health/sentry-test
 * Triggers a safe test error to verify Sentry is capturing exceptions.
 * Only available in non-production or when explicitly enabled.
 */
export function sentryTest(_request: Request, _response: Response): void {
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
 */
export async function getHealthDetailed(_request: Request, response: Response): Promise<void> {
  const checks: Record<string, { status: "ok" | "error" | "skipped"; latencyMs?: number; detail?: string }> = {};

  // Database
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
  } catch (error) {
    checks.database = { status: "error", latencyMs: Date.now() - dbStart, detail: error instanceof Error ? error.message : String(error) };
  }

  // Stripe
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

  response.status(critical ? 200 : 503).json({ status: overall, checks });
}
