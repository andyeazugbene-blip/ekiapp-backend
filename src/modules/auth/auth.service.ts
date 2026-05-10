import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { UserRole } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { AuthUser, JwtPayload, LoginInput, RegisterInput } from "./auth.types";

const BCRYPT_ROUNDS = 10;

function signToken(user: { id: string; role: UserRole; email: string }): string {
  const payload: JwtPayload = { sub: user.id, role: user.role, email: user.email };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as SignOptions);
}

function toAuthUser(user: { id: string; email: string; name: string; role: UserRole }): AuthUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
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
        role: UserRole.BUYER,
      },
    });

    return { user: toAuthUser(user), token: signToken(user) };
  },

  async login(input: LoginInput): Promise<{ user: AuthUser; token: string }> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      throw new AppError("Invalid credentials", 401);
    }

    const valid = await bcrypt.compare(input.password, user.password);
    if (!valid) {
      throw new AppError("Invalid credentials", 401);
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

  verifyToken(token: string): JwtPayload {
    try {
      return jwt.verify(token, env.jwtSecret) as JwtPayload;
    } catch {
      throw new AppError("Invalid or expired token", 401);
    }
  },
};
