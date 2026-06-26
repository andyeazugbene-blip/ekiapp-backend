import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { otpService } from "./otp.service";

const VALID_PURPOSES = ["vendor_onboarding_email", "buyer_signup_email", "guest_order_lookup"] as const;

function validateSendOtpInput(body: unknown): { contact: string; purpose: string } {
  if (!body || typeof body !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.contact !== "string" || !raw.contact.trim() || !raw.contact.includes("@")) {
    throw new AppError("Valid email address required", 400);
  }
  const purpose = typeof raw.purpose === "string" ? raw.purpose.trim() : "";
  if (!VALID_PURPOSES.includes(purpose as (typeof VALID_PURPOSES)[number])) {
    throw new AppError("Invalid purpose", 400);
  }

  return { contact: raw.contact.trim().toLowerCase(), purpose };
}

function validateVerifyOtpInput(body: unknown): { contact: string; code: string; purpose: string } {
  if (!body || typeof body !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.contact !== "string" || !raw.contact.trim() || !raw.contact.includes("@")) {
    throw new AppError("Valid email address required", 400);
  }
  if (typeof raw.code !== "string" || !/^\d{6}$/.test(raw.code.trim())) {
    throw new AppError("Code must be a 6-digit number", 400);
  }
  const purpose = typeof raw.purpose === "string" ? raw.purpose.trim() : "";
  if (!VALID_PURPOSES.includes(purpose as (typeof VALID_PURPOSES)[number])) {
    throw new AppError("Invalid purpose", 400);
  }

  return {
    contact: raw.contact.trim().toLowerCase(),
    code: raw.code.trim(),
    purpose,
  };
}

/**
 * POST /api/auth/send-otp
 * Sends a 6-digit OTP to the provided email via Resend.
 * Always returns the same response regardless of whether the email exists.
 */
export async function sendOtp(request: Request, response: Response): Promise<void> {
  const { contact, purpose } = validateSendOtpInput(request.body);

  // If authenticated, ensure the contact belongs to the current user
  if (request.user) {
    if (request.user.email !== contact) {
      throw new AppError("Contact does not match authenticated user", 403);
    }
  }

  // Always respond with success to prevent email enumeration
  try {
    await otpService.sendOtp(contact, purpose as (typeof VALID_PURPOSES)[number]);
  } catch {
    // Swallow errors to prevent enumeration — still return success
  }

  response.status(200).json({ message: "Verification code sent" });
}

/**
 * POST /api/auth/verify-otp
 * Verifies a 6-digit OTP code.
 */
export async function verifyOtp(request: Request, response: Response): Promise<void> {
  const { contact, code, purpose } = validateVerifyOtpInput(request.body);

  // If authenticated, ensure the contact belongs to the current user
  if (request.user) {
    if (request.user.email !== contact) {
      throw new AppError("Contact does not match authenticated user", 403);
    }
  }

  await otpService.verifyOtp(contact, code, purpose as (typeof VALID_PURPOSES)[number]);
  response.status(200).json({ verified: true });
}
