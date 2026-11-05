/**
 * The demo/real money boundary. Demo wallets hold credit nobody paid for, so
 * crossing this boundary in either direction costs real money.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  vendorFindMany: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.userFindUnique },
    vendor: { findMany: m.vendorFindMany },
  },
}));

import {
  assertCardAllowedForAccount,
  assertSameAccountWorld,
  DEMO_REAL_CARD_BLOCKED_CODE,
  TEST_ACCOUNT_ISOLATION_CODE,
  viewerIsTest,
} from "../shared/test-accounts";

const originalKey = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  process.env.STRIPE_SECRET_KEY = originalKey;
});

describe("viewerIsTest", () => {
  it("treats anonymous and unknown viewers as real", async () => {
    expect(await viewerIsTest(undefined)).toBe(false);
    m.userFindUnique.mockResolvedValue(null);
    expect(await viewerIsTest("ghost")).toBe(false);
  });

  it("is true only for a flagged account", async () => {
    m.userFindUnique.mockResolvedValue({ isTest: true });
    expect(await viewerIsTest("demo")).toBe(true);
  });
});

describe("assertSameAccountWorld", () => {
  it("blocks a demo buyer from a real store, so fake credit can't become a real payout", async () => {
    m.userFindUnique.mockResolvedValue({ isTest: true });
    m.vendorFindMany.mockResolvedValue([{ isTest: false }]);
    await expect(assertSameAccountWorld("demo", ["v1"])).rejects.toMatchObject({
      statusCode: 403,
      code: TEST_ACCOUNT_ISOLATION_CODE,
    });
  });

  it("blocks a real buyer from a demo store, so nobody pays for goods that won't ship", async () => {
    m.userFindUnique.mockResolvedValue({ isTest: false });
    m.vendorFindMany.mockResolvedValue([{ isTest: true }]);
    await expect(assertSameAccountWorld("real", ["v1"])).rejects.toMatchObject({ statusCode: 403 });
  });

  it("blocks a cart mixing real and demo stores", async () => {
    m.userFindUnique.mockResolvedValue({ isTest: false });
    m.vendorFindMany.mockResolvedValue([{ isTest: false }, { isTest: true }]);
    await expect(assertSameAccountWorld("real", ["v1", "v2"])).rejects.toMatchObject({ statusCode: 403 });
  });

  it("allows buyers inside their own world", async () => {
    m.userFindUnique.mockResolvedValue({ isTest: true });
    m.vendorFindMany.mockResolvedValue([{ isTest: true }]);
    await expect(assertSameAccountWorld("demo", ["v1"])).resolves.toBeUndefined();

    m.userFindUnique.mockResolvedValue({ isTest: false });
    m.vendorFindMany.mockResolvedValue([{ isTest: false }]);
    await expect(assertSameAccountWorld("real", ["v1"])).resolves.toBeUndefined();
  });
});

describe("assertCardAllowedForAccount", () => {
  it("refuses a demo account's card on live Stripe", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    m.userFindUnique.mockResolvedValue({ isTest: true });
    await expect(assertCardAllowedForAccount("demo")).rejects.toMatchObject({
      statusCode: 403,
      code: DEMO_REAL_CARD_BLOCKED_CODE,
    });
  });

  it("allows real accounts on live Stripe", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    m.userFindUnique.mockResolvedValue({ isTest: false });
    await expect(assertCardAllowedForAccount("real")).resolves.toBeUndefined();
  });

  it("allows demo accounts on test Stripe, so the card flow can still be exercised", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    await expect(assertCardAllowedForAccount("demo")).resolves.toBeUndefined();
    expect(m.userFindUnique).not.toHaveBeenCalled();
  });
});
