import type { NextFunction, Request, Response } from "express";

import { logger } from "../lib/logger";
import { AppError } from "../shared/errors/app-error";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Cloudflare Turnstile CAPTCHA validation middleware.
 *
 * Behavior matrix:
 *   1. TURNSTILE_DISABLED=true                       → skip validation entirely.
 *   2. TURNSTILE_SECRET_KEY missing in dev/test      → skip (no friction in local).
 *   3. TURNSTILE_SECRET_KEY missing in production    → 503 with TURNSTILE_NOT_CONFIGURED
 *      (operator must set the key OR explicitly set TURNSTILE_DISABLED=true).
 *   4. cf-turnstile-response missing in body         → 400 "Turnstile token required".
 *   5. Token rejected by Cloudflare                  → 403 "Captcha verification failed".
 *   6. Network failure reaching Cloudflare           → 503 TURNSTILE_VERIFY_UNAVAILABLE
 *      (in non-production we fail open to keep dev unblocked).
 *
 * Env vars are read on every call so test-time `vi.stubEnv` works correctly.
 */
export function requireTurnstile(request: Request, _response: Response, next: NextFunction): void {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const secret = process.env.TURNSTILE_SECRET_KEY ?? "";
  const disabled = process.env.TURNSTILE_DISABLED === "true";

  // 1. Explicit kill switch (used during frontend rollout)
  if (disabled) {
    next();
    return;
  }

  // 2. Skip in dev/test if no key configured
  if (!secret && (nodeEnv === "development" || nodeEnv === "test")) {
    next();
    return;
  }

  // 3. Production without key — controlled error with distinct code
  if (!secret) {
    logger.error(
      "TURNSTILE_SECRET_KEY not configured in production. " +
      "Set the key or TURNSTILE_DISABLED=true to bypass intentionally.",
    );
    next(
      new AppError(
        "Captcha is not configured on the server. Set TURNSTILE_SECRET_KEY or TURNSTILE_DISABLED=true.",
        503,
        null,
        "TURNSTILE_NOT_CONFIGURED",
      ),
    );
    return;
  }

  // 4. Missing token in body
  const token = (request.body as Record<string, unknown> | undefined)?.["cf-turnstile-response"];
  if (!token || typeof token !== "string") {
    next(new AppError("Turnstile token required", 400, null, "TURNSTILE_TOKEN_MISSING"));
    return;
  }

  // 5/6. Verify with Cloudflare
  verifyTurnstileToken(secret, token, request.ip ?? "")
    .then((valid) => {
      if (!valid) {
        next(new AppError("Captcha verification failed", 403, null, "TURNSTILE_INVALID_TOKEN"));
        return;
      }
      next();
    })
    .catch((error) => {
      logger.error("Turnstile verification network error", { error: String(error) });
      // Fail open in non-production to avoid blocking development
      if (nodeEnv !== "production") {
        next();
        return;
      }
      next(
        new AppError(
          "Captcha verification temporarily unavailable. Please retry.",
          503,
          null,
          "TURNSTILE_VERIFY_UNAVAILABLE",
        ),
      );
    });
}

async function verifyTurnstileToken(
  secret: string,
  token: string,
  remoteIp: string,
): Promise<boolean> {
  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: remoteIp,
  });

  const res = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = (await res.json()) as { success: boolean; "error-codes"?: string[] };

  if (!json.success) {
    logger.warn("Turnstile verification failed", { errorCodes: json["error-codes"] });
  }

  return json.success;
}
