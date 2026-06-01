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

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_EXPIRY_HOURS = 1;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

const JWT_SIGN_OPTIONS: SignOptions = { algorithm: "HS256", expiresIn: env.jwtExpiresIn as string & SignOptions["expiresIn"] };

type AuthUserRecord = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  avatar: string | null;
  country: string | null;
  isSuspended: boolean;
  suspendedReason: string | null;
  role: UserRole;
  trustScore: number;
  createdAt: Date;
  vendor?: {
    storeName: string;
    storeSlug: string;
    description: string | null;
    businessType: string | null;
    sellerRegion: string | null;
    city: string | null;
    avatar: string | null;
    coverImage: string | null;
  } | null;
};

interface AuthRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

function signToken(user: { id: string; role: UserRole; email: string; tokenVersion: number }): string {
  const payload: JwtPayload = { sub: user.id, role: user.role, email: user.email, tv: user.tokenVersion };
  return jwt.sign(payload as object, env.jwtSecret, JWT_SIGN_OPTIONS);
}

async function writeAuditLogSafe(data: {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const auditModel = (prisma as unknown as { auditLog?: { create: (args: any) => Promise<unknown> } }).auditLog;
  if (!auditModel?.create) return;
  await auditModel.create({ data }).catch(() => undefined);
}

function toAuthUser(user: AuthUserRecord): AuthUser {
  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    avatar: user.avatar,
    country: user.country,
    role: user.role,
    trustScore: user.trustScore,
    createdAt: user.createdAt,
  };

  if (user.role === UserRole.VENDOR && user.vendor) {
    authUser.storeName = user.vendor.storeName;
    authUser.storeSlug = user.vendor.storeSlug;
    authUser.storeDescription = user.vendor.description;
    authUser.businessType = user.vendor.businessType;
    authUser.sellerRegion = user.vendor.sellerRegion;
    authUser.city = user.vendor.city;
    authUser.avatar = user.vendor.avatar ?? user.avatar;
    authUser.coverImage = user.vendor.coverImage;
  }

  return authUser;
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

    // Send email verification token (non-blocking)
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token: verificationToken,
        expiresAt: verificationExpiry,
      },
    }).catch((err: unknown) => {
      logger.error("Failed to create email verification token", { userId: user.id, error: String(err) });
    });

    return { user: toAuthUser(user), token: signToken(user) };
  },

  async login(input: LoginInput, meta?: AuthRequestMeta): Promise<{ user: AuthUser; token: string }> {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      include: { vendor: true },
    });

    // Do not reveal whether email exists
    if (!user) {
      throw new AppError("Invalid credentials", 401);
    }

    if (user.isSuspended) {
      await writeAuditLogSafe({
        actorId: user.id,
        action: "LOGIN_BLOCKED_SUSPENDED",
        entityType: "User",
        entityId: user.id,
        metadata: {
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          reason: user.suspendedReason ?? null,
        },
      });
      throw new AppError("Your account has been suspended. Contact support.", 423);
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      logger.warn("Login attempt on locked account", { userId: user.id });
      await writeAuditLogSafe({
        actorId: user.id,
        action: "LOGIN_BLOCKED_LOCKOUT",
        entityType: "User",
        entityId: user.id,
        metadata: { ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null },
      });
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

      await writeAuditLogSafe({
        actorId: user.id,
        action: shouldLock ? "LOGIN_FAILED_LOCKED" : "LOGIN_FAILED",
        entityType: "User",
        entityId: user.id,
        metadata: {
          attempts: newAttempts,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
        },
      });

      if (shouldLock) {
        logger.warn("Account locked after failed attempts", { userId: user.id });
      }

      throw new AppError("Invalid credentials", 401);
    }

    // Successful login: reset failed attempts, clear lockout, and opportunistic rehash
    const needsRehash = bcrypt.getRounds(user.password) < BCRYPT_ROUNDS;
    if (user.failedLoginAttempts > 0 || user.lockedUntil || needsRehash) {
      const data: Record<string, unknown> = { failedLoginAttempts: 0, lockedUntil: null };
      if (needsRehash) {
        data.password = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      }
      await prisma.user.update({ where: { id: user.id }, data });
    }

    await writeAuditLogSafe({
      actorId: user.id,
      action: "LOGIN_SUCCESS",
      entityType: "User",
      entityId: user.id,
      metadata: { ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null, role: user.role },
    });

    return { user: toAuthUser(user), token: signToken(user) };
  },

  async getCurrentUser(userId: string): Promise<AuthUser> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendor: true },
    });
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
      include: { vendor: true },
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

  async verifyEmail(token: string): Promise<{ message: string }> {
    const record = await prisma.emailVerificationToken.findUnique({ where: { token } });
    if (!record) throw new AppError("Invalid verification token", 400);
    if (record.usedAt) throw new AppError("Token already used", 400);
    if (record.expiresAt < new Date()) throw new AppError("Verification token expired", 400);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
      prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: "Email verified successfully." };
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
  async verifyTokenVersion(
    userId: string,
    tokenVersion: number,
  ): Promise<{ valid: boolean; role?: UserRole; suspended?: boolean }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true, role: true, isSuspended: true },
    });
    if (!user) return { valid: false };
    return { valid: user.tokenVersion === tokenVersion, role: user.role, suspended: user.isSuspended };
  },

  /**
   * Issue a new JWT. Used when the user's role changes (e.g. after vendor creation)
   * so the frontend can continue without re-login.
   */
  signTokenPublic(user: { id: string; role: UserRole; email: string; tokenVersion: number }): string {
    return signToken(user);
  },
};
