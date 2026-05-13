import jwt from "jsonwebtoken";
import type { UserRole } from "@prisma/client";

const JWT_SECRET = "test-secret-key-for-testing-only";

/**
 * Generate a test JWT token for a given user.
 */
export function generateTestToken(user: {
  id: string;
  role: UserRole;
  email: string;
  tokenVersion?: number;
}): string {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, tv: user.tokenVersion ?? 0 },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: "1h" },
  );
}

/**
 * Create auth header for test requests.
 */
export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
