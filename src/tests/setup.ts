import { beforeAll, afterAll } from "vitest";

// Test setup — runs before all test files.
// In a real CI environment, you'd spin up a test database here.
// For now, we set NODE_ENV and mock external services.

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-key-for-testing-only";
  process.env.JWT_EXPIRES_IN = "1h";
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
});

afterAll(() => {
  // Cleanup if needed
});
