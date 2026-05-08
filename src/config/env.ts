function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
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
  defaultCurrency: process.env.DEFAULT_CURRENCY ?? "usd",
  platformFeeBps: getPlatformFeeBps(),
} as const;
