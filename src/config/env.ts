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

function getPriceApprovalTimeoutHours(): number | null {
  // spec §18.11 "Buyer does not approve price" — the architecture doc
  // requires this be handled but never states how long a buyer has to
  // respond. That's a genuine product decision, not something to invent
  // here — absent entirely, expirePriceApprovalTimeouts() stays a real
  // no-op (CLIENT CONFIGURATION REQUIRED) rather than silently applying a
  // made-up business value.
  const raw = process.env.PRICE_APPROVAL_TIMEOUT_HOURS;
  if (!raw) return null;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("PRICE_APPROVAL_TIMEOUT_HOURS must be a positive number of hours");
  }
  return hours;
}

function getFulfilmentStaleThresholdHours(): number | null {
  // Fallback-only signal for a CampaignFulfilment with no
  // estimatedReadyAt set at all — the primary delay check compares
  // against that real business date instead. No client-approved
  // "how long is too long with no progress" value exists, so this stays
  // a genuine no-op (CLIENT CONFIGURATION REQUIRED) until set.
  const raw = process.env.FULFILMENT_STALE_THRESHOLD_HOURS;
  if (!raw) return null;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("FULFILMENT_STALE_THRESHOLD_HOURS must be a positive number of hours");
  }
  return hours;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: getPort(),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  stripeSecretKey: getRequiredEnv("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: getRequiredEnv("STRIPE_WEBHOOK_SECRET"),
  stripeIdentityWebhookSecret: process.env.STRIPE_IDENTITY_WEBHOOK_SECRET ?? "",
  defaultCurrency: process.env.DEFAULT_CURRENCY ?? "eur",
  platformFeeBps: getPlatformFeeBps(),
  jwtSecret: getJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  publicStoreBaseUrl: (process.env.PUBLIC_STORE_BASE_URL ?? "https://culinarytales.app").replace(/\/+$/, ""),
  frontendUrl: (process.env.FRONTEND_URL ?? process.env.PUBLIC_WEB_URL ?? "https://culinarytales.app").replace(/\/+$/, ""),
  // Google/Apple Sign-In — optional. Each is a client-facing identifier
  // (not a secret) needed to validate the `aud` claim on a verified
  // provider token. Absent entirely = that provider's routes return
  // 503 OAUTH_PROVIDER_NOT_CONFIGURED rather than crashing boot, since
  // this is an additive feature that must not take down existing auth.
  googleClientIds: [
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_ID,
  ].filter((v): v is string => Boolean(v && v.trim())),
  appleBundleId: process.env.APPLE_BUNDLE_ID ?? "",
  priceApprovalTimeoutHours: getPriceApprovalTimeoutHours(),
  fulfilmentStaleThresholdHours: getFulfilmentStaleThresholdHours(),
} as const;
