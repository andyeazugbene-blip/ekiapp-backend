import crypto from "crypto";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { sendEmail } from "../../lib/email";
import { emailTemplates } from "../../lib/email-templates";
import { AppError } from "../../shared/errors/app-error";

const OTP_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const VALID_PURPOSES = ["vendor_onboarding_email"] as const;
type OtpPurpose = (typeof VALID_PURPOSES)[number];

/**
 * Generate a cryptographically random 6-digit numeric OTP.
 */
function generateOtpCode(): string {
  // Generate a random number between 100000 and 999999
  const buffer = crypto.randomBytes(4);
  const num = buffer.readUInt32BE(0) % 900000 + 100000;
  return String(num);
}

/**
 * Hash an OTP code using SHA-256. We never store plaintext codes.
 */
function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export const otpService = {
  /**
   * Send a new OTP to the given email. Invalidates any existing active OTPs
   * for the same email+purpose combination.
   */
  async sendOtp(email: string, purpose: OtpPurpose): Promise<void> {
    // Validate purpose
    if (!VALID_PURPOSES.includes(purpose)) {
      throw new AppError("Invalid purpose", 400);
    }

    // Invalidate all existing unconsumed OTPs for this email+purpose
    await prisma.emailOtp.updateMany({
      where: {
        email: email.toLowerCase(),
        purpose,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    // Generate new OTP
    const code = generateOtpCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Store hashed OTP
    await prisma.emailOtp.create({
      data: {
        email: email.toLowerCase(),
        codeHash,
        purpose,
        expiresAt,
      },
    });

    // Send email via Resend (never log the code)
    const template = emailTemplates.otpVerification({ code });
    await sendEmail({
      to: email,
      subject: template.subject,
      html: template.html,
    });
  },

  /**
   * Verify an OTP code. Returns true if valid, throws on failure.
   * Enforces max attempts and expiry.
   */
  async verifyOtp(email: string, code: string, purpose: OtpPurpose): Promise<boolean> {
    if (!VALID_PURPOSES.includes(purpose)) {
      throw new AppError("Invalid purpose", 400);
    }

    // Find the most recent unconsumed OTP for this email+purpose
    const otp = await prisma.emailOtp.findFirst({
      where: {
        email: email.toLowerCase(),
        purpose,
        consumedAt: null,
      },
      orderBy: CURSOR_ORDER_BY,
    });

    if (!otp) {
      throw new AppError("No active verification code found. Please request a new one.", 400);
    }

    // Check expiry
    if (otp.expiresAt < new Date()) {
      throw new AppError("Verification code has expired. Please request a new one.", 400);
    }

    // Check max attempts
    if (otp.attempts >= MAX_ATTEMPTS) {
      throw new AppError("Too many attempts. Please request a new code.", 429);
    }

    // Increment attempts
    await prisma.emailOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });

    // Verify hash
    const inputHash = hashCode(code);
    if (inputHash !== otp.codeHash) {
      throw new AppError("Invalid verification code", 400);
    }

    // Mark as consumed
    await prisma.emailOtp.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    // Update user's emailVerifiedAt
    await prisma.user.updateMany({
      where: { email: email.toLowerCase(), emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });

    return true;
  },
};
