import type { UserRole } from "@prisma/client";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
  country?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface JwtPayload {
  sub: string;
  role: UserRole;
  email: string;
  tv: number; // tokenVersion — for revocation
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  avatar: string | null;
  country: string | null;
  role: UserRole;
  createdAt: Date;
}

export interface UpdateProfileInput {
  name?: string;
  phone?: string | null;
  avatar?: string | null;
  country?: string | null;
}

export interface ForgotPasswordInput {
  email: string;
}

export interface ResetPasswordInput {
  token: string;
  password: string;
}
