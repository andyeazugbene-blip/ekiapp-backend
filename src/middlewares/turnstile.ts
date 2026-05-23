import type { NextFunction, Request, Response } from "express";

import { logger } from "../lib/logger";
import { AppError } from "../shared/errors/app-error";

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY ?? "";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Cloudflare Turnstile CAPTCHA validation middleware.
 *
 * Behavior:
 * - In test/development: skipped unless TURNSTILE_SECRET_KEY is explicitly set.
 * - In production: required unless TURNSTILE_DISABLED=true.
 * - Expects `cf-turnstile-response` in the request body.
 */
export function requireTurnstile(request: Request, _response: Response, next: NextFunction): void {
  const nodeEnv = process.env.NODE_ENV ?? "development";

  // Skip in test/development if key not configured
  if (!TURNSTILE_SECRET_KEY && (nodeEnv === "development" || nodeEnv === "test")) {
    next();
    return;
  }

  // Allow explicit disable in production (escape hatch)
  if (process.env.TURNSTILE_DISABLED === "true") {
    next();
    return;
  }

  // In production without key — reject (misconfiguration)
  if (!TURNSTILE_SECRET_KEY && nodeEnv === "production") {
    logger.error("TURNSTILE_SECRET_KEY not configured in production");
    next(new AppError("Server misconfiguration: captcha not available", 503));
    return;
  }

  const token = (request.body as Record<string, unknown>)?.["cf-turnstile-response"];

  if (!token || typeof token !== "string") {
    next(new AppError("Missing captcha token (cf-turnstile-response)", 400));
    return;
  }

  verifyTurnstileToken(token, request.ip ?? "")
    .then((valid) => {
      if (!valid) {
        next(new AppError("Captcha verification failed", 403));
        return;
      }
      next();
    })
    .catch((error) => {
      logger.error("Turnstile verification error", { error: String(error) });
      // Fail open in non-production to avoid blocking development
      if (nodeEnv !== "production") {
        next();
        return;
      }
      next(new AppError("Captcha verification unavailable", 503));
    });
}

async function verifyTurnstileToken(token: string, remoteIp: string): Promise<boolean> {
  const body = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
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
