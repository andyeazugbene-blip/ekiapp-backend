import crypto from "crypto";

import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { UserRole } from "@prisma/client";

import { env } from "../../config/env";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type {
  AuthUser,
  ForgotPasswordInput,
  JwtPayload,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from "./auth.types";

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_EXPIRY_HOURS = 1;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function signToken(user: { id: string; role: UserRole; email: string; tokenVersion: number }): string {
  const payload: JwtPayload = { sub: user.id, role: user.role, email: user.email, tv: user.tokenVersion };
  return jwt.sign(payload, env.jwtSecret, { algorithm: "HS256", expiresIn: env.jwtExpiresIn } as SignOptions);
}

function toAuthUser(user: {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  avatar: string | null;
  country: string | null;
  role: UserRole;
  createdAt: Date;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    avatar: user.avatar,
    country: user.country,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export const authService = {
  async register(input: RegisterInput): Promise<{ user: AuthUser; token: string }> {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AppError("Email already registered", 409);
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        password: passwordHash,
        phone: input.phone,
        country: input.country,
        role: UserRole.BUYER,
      },
    });

    // Send welcome email (non-blocking)
    const welcome = emailTemplates.welcomeBuyer({ name: user.name });
    enqueueEmail({ to: user.email, subject: welcome.subject, html: welcome.html });

    return { user: toAuthUser(user), token: signToken(user) };
  },

  async login(input: LoginInput): Promise<{ user: AuthUser; token: string }> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    // Do not reveal whether email exists
    if (!user) {
      throw new AppError("Invalid credentials", 401);
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      logger.warn("Login attempt on locked account", { userId: user.id });
      throw new AppError("Account temporarily locked. Try again later.", 423);
    }

    const valid = await bcrypt.compare(input.password, user.password);

    if (!valid) {
      // Increment failed attempts
      const newAttempts = user.failedLoginAttempts + 1;
      const shouldLock = newAttempts >= MAX_FAILED_ATTEMPTS;

      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: newAttempts,
          ...(shouldLock ? { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) } : {}),
        },
      });

      if (shouldLock) {
        logger.warn("Account locked after failed attempts", { userId: user.id });
      }

      throw new AppError("Invalid credentials", 401);
    }

    // Successful login: reset failed attempts and clear lockout
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    return { user: toAuthUser(user), token: signToken(user) };
  },

  async getCurrentUser(userId: string): Promise<AuthUser> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError("User not found", 404);
    }
    return toAuthUser(user);
  },

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<AuthUser> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError("User not found", 404);
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: input,
    });

    return toAuthUser(updated);
  },

  async forgotPassword(input: ForgotPasswordInput): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    // Always return success to prevent email enumeration
    if (!user) {
      return { message: "If that email exists, a reset link has been sent." };
    }

    // Invalidate any existing tokens for this user
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    // Send password reset email
    const resetBaseUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
    const resetUrl = `${resetBaseUrl}/reset-password?token=${token}`;
    const template = emailTemplates.passwordReset({ name: user.name, resetUrl });
    await enqueueEmail({ to: user.email, subject: template.subject, html: template.html });

    if (env.nodeEnv !== "production") {
      logger.info("Password reset token generated", { userId: user.id });
    }

    return { message: "If that email exists, a reset link has been sent." };
  },

  async resetPassword(input: ResetPasswordInput): Promise<{ message: string }> {
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token: input.token },
    });

    if (!resetToken) {
      throw new AppError("Invalid or expired reset token", 400);
    }

    if (resetToken.usedAt) {
      throw new AppError("Reset token already used", 400);
    }

    if (resetToken.expiresAt < new Date()) {
      throw new AppError("Reset token expired", 400);
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // Increment tokenVersion to invalidate all existing JWTs
    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.userId },
        data: {
          password: passwordHash,
          tokenVersion: { increment: 1 },
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: "Password reset successfully." };
  },

  /**
   * Verify JWT signature and structure. Does NOT check tokenVersion
   * (that requires a DB call and is done in the authenticate middleware).
   */
  verifyToken(token: string): JwtPayload {
    try {
      return jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as JwtPayload;
    } catch {
      throw new AppError("Invalid or expired token", 401);
    }
  },

  /**
   * Verify that the token's tokenVersion matches the user's current version.
   * Called by authenticate middleware on every request.
   */
  async verifyTokenVersion(userId: string, tokenVersion: number): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    if (!user) return false;
    return user.tokenVersion === tokenVersion;
  },
};
