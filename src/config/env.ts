import "dotenv/config";

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getJwtSecret(): string {
  const value = getRequiredEnv("JWT_SECRET");
  const nodeEnv = process.env.NODE_ENV ?? "development";
  // In production, require a strong secret. 32 bytes ≈ 256 bits, which matches
  // the HS256 output size and is the minimum length the spec recommends.
  // Test/dev keep using the short fixture secret so the existing test fixtures
  // (`test-secret-key-for-testing-only`) keep working.
  if (nodeEnv === "production" && value.length < 32) {
    throw new Error(
      "JWT_SECRET is too short for production. Use at least 32 characters " +
      "(e.g. `node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\"`).",
    );
  }
  // Reject the obvious placeholder value that ships in .env.example.
  if (value === "change_me_in_production") {
    throw new Error("JWT_SECRET still set to the example placeholder. Generate a real secret.");
  }
  return value;
}

function getPort(): number {
  const rawPort = process.env.PORT ?? "4000";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  return port;
}

function getPlatformFeeBps(): number {
  const rawValue = process.env.PLATFORM_FEE_BPS ?? "1000";
  const platformFeeBps = Number(rawValue);

  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10000) {
    throw new Error("PLATFORM_FEE_BPS must be an integer between 0 and 10000");
  }

  return platformFeeBps;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: getPort(),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  stripeSecretKey: getRequiredEnv("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: getRequiredEnv("STRIPE_WEBHOOK_SECRET"),
  defaultCurrency: process.env.DEFAULT_CURRENCY ?? "eur",
  platformFeeBps: getPlatformFeeBps(),
  jwtSecret: getJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  publicStoreBaseUrl: (process.env.PUBLIC_STORE_BASE_URL ?? "https://culinarytales.app").replace(/\/+$/, ""),
  frontendUrl: (process.env.FRONTEND_URL ?? process.env.PUBLIC_WEB_URL ?? "https://culinarytales.app").replace(/\/+$/, ""),
} as const;
