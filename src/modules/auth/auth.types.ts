import type { UserRole } from "@prisma/client";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface JwtPayload {
  sub: string;
  role: UserRole;
  email: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
