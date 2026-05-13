import { PrismaClient } from "@prisma/client";

// PrismaClient singleton.
//
// In long-lived processes (local dev, `tsx watch`) module reloads can create
// many PrismaClient instances and exhaust DB connections. In serverless
// (Vercel) the same Lambda instance is reused while warm, so caching the
// client on globalThis ensures a single client per worker. Use a Neon
// pooled connection string in DATABASE_URL for production (see README).
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
