// Vitest setup file — runs once before any test file is imported.
// Set required env vars at module-load time so config/env.ts (which reads
// them on import) doesn't throw.

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-key-for-testing-only";
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "1h";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_fake";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
process.env.PUBLIC_STORE_BASE_URL = process.env.PUBLIC_STORE_BASE_URL ?? "https://waqti.pro";
