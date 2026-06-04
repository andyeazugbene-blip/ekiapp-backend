import type { UserRole } from "@prisma/client";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
  country?: string;
  role?: Exclude<UserRole, "ADMIN">;
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
  referralCode: string | null;
  role: UserRole;
  trustScore: number;
  createdAt: Date;
  storeName?: string;
  storeSlug?: string;
  storeDescription?: string | null;
  businessType?: string | null;
  sellerRegion?: string | null;
  city?: string | null;
  coverImage?: string | null;
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
