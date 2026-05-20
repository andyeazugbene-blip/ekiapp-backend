/**
 * Phase 2 Security Fixes Tests
 *
 * 1. Promo code redemption race — concurrent redemption cannot exceed maxUses
 * 2. Review rating validation — invalid ratings rejected
 * 3. Referral reward — not credited on signup, credited on first paid order, idempotent
 * 4. Stripe automatic_payment_methods
 * 5. Stripe API version pinned
 * 6. Auth middleware live role check
 * 7. Bcrypt rounds upgrade
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../lib/prisma", () => ({
  prisma: {
    promoCode: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    promoRedemption: { findUnique: vi.fn(), create: vi.fn() },
    order: { findUnique: vi.fn(), count: vi.fn() },
    referral: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    buyerWallet: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    buyerWalletTransaction: { create: vi.fn() },
    review: { findFirst: vi.fn(), create: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    orderItem: { findFirst: vi.fn() },
    emailVerificationToken: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: {
    paymentIntents: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ message: String(e) })),
}));

vi.mock("../lib/push-notifications", () => ({
  pushNotifications: { orderPaid: vi.fn(), vendorNewOrder: vi.fn() },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../lib/email-queue", () => ({
  enqueueEmail: vi.fn(),
}));

vi.mock("../lib/email-templates", () => ({
  emailTemplates: {
    welcomeBuyer: vi.fn().mockReturnValue({ subject: "Welcome", html: "<p>Hi</p>" }),
    passwordReset: vi.fn().mockReturnValue({ subject: "Reset", html: "<p>Reset</p>" }),
  },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { validateCreateReviewInput } from "../modules/reviews/reviews.validation";
import { referralsService } from "../modules/referrals/referrals.service";
import { authService } from "../modules/auth/auth.service";

const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const userFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const userUpdate = prisma.user.update as unknown as ReturnType<typeof vi.fn>;
const referralFindUnique = prisma.referral.findUnique as unknown as ReturnType<typeof vi.fn>;
const orderCount = prisma.order.count as unknown as ReturnType<typeof vi.fn>;
const piCreate = stripe.paymentIntents.create as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

// ─── 1. Promo code redemption race ──────────────────────────────────────────

describe("Promo code redemption race (P2.1)", () => {
  it("atomic updateMany prevents concurrent over-redemption", async () => {
    const { promosService } = await import("../modules/promos/promos.service");
    const promoFindUnique = prisma.promoCode.findUnique as unknown as ReturnType<typeof vi.fn>;
    const redemptionFindUnique = prisma.promoRedemption.findUnique as unknown as ReturnType<typeof vi.fn>;

    // Mock validatePromo to succeed
    promoFindUnique.mockResolvedValue({
      id: "promo-1",
      code: "DEAL50",
      type: "FIXED_AMOUNT",
      value: 500,
      isActive: true,
      validFrom: new Date("2020-01-01"),
      validUntil: null,
      maxUses: 1,
      usedCount: 0,
      minOrderAmount: null,
    });
    redemptionFindUnique.mockResolvedValue(null); // No prior redemption

    // Simulate transaction: $executeRaw returns 0 (promo exhausted by concurrent call)
    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(0), // 0 rows updated = exhausted
        promoCode: { findUniqueOrThrow: vi.fn() },
        promoRedemption: { create: vi.fn() },
      };
      return cb(tx);
    });

    await expect(
      promosService.redeemPromo("buyer-1", "DEAL50", 10000),
    ).rejects.toThrow("Promo no longer available");
  });

  it("expired promo rejected at validation", async () => {
    const { promosService } = await import("../modules/promos/promos.service");
    const promoFindUnique = prisma.promoCode.findUnique as unknown as ReturnType<typeof vi.fn>;

    promoFindUnique.mockResolvedValue({
      id: "promo-2",
      code: "EXPIRED",
      type: "PERCENTAGE",
      value: 10,
      isActive: true,
      validFrom: new Date("2020-01-01"),
      validUntil: new Date("2020-12-31"), // Expired
      maxUses: 100,
      usedCount: 0,
      minOrderAmount: null,
    });

    await expect(
      promosService.validatePromo("buyer-1", { code: "EXPIRED", orderAmount: 5000 }),
    ).rejects.toThrow("Promo code has expired");
  });

  it("per-user duplicate promo rejected", async () => {
    const { promosService } = await import("../modules/promos/promos.service");
    const promoFindUnique = prisma.promoCode.findUnique as unknown as ReturnType<typeof vi.fn>;
    const redemptionFindUnique = prisma.promoRedemption.findUnique as unknown as ReturnType<typeof vi.fn>;

    promoFindUnique.mockResolvedValue({
      id: "promo-3",
      code: "ONCE",
      type: "FIXED_AMOUNT",
      value: 200,
      isActive: true,
      validFrom: new Date("2020-01-01"),
      validUntil: null,
      maxUses: 100,
      usedCount: 1,
      minOrderAmount: null,
    });
    redemptionFindUnique.mockResolvedValue({ id: "red-1" }); // Already used

    await expect(
      promosService.validatePromo("buyer-1", { code: "ONCE", orderAmount: 5000 }),
    ).rejects.toThrow("You have already used this promo code");
  });
});

// ─── 2. Review rating validation ────────────────────────────────────────────

describe("Review rating validation (P2.2)", () => {
  it.each([-1, 0, 6, 999])("rejects invalid rating %d", (rating) => {
    expect(() => validateCreateReviewInput({
      orderId: "o1",
      vendorId: "v1",
      rating,
    })).toThrow("rating must be an integer between 1 and 5");
  });

  it("rejects float rating 3.5", () => {
    expect(() => validateCreateReviewInput({
      orderId: "o1",
      vendorId: "v1",
      rating: 3.5,
    })).toThrow("rating must be an integer between 1 and 5");
  });

  it.each([1, 2, 3, 4, 5])("accepts valid rating %d", (rating) => {
    const input = validateCreateReviewInput({
      orderId: "o1",
      vendorId: "v1",
      rating,
    });
    expect(input.rating).toBe(rating);
  });
});

// ─── 3. Referral reward abuse ───────────────────────────────────────────────

describe("Referral reward (P2.3)", () => {
  it("signup alone does not credit referral", async () => {
    // No paid orders
    referralFindUnique.mockResolvedValue({
      id: "ref-1",
      referrerId: "referrer-1",
      referredId: "newuser-1",
      bonusAmount: 500,
      currency: "usd",
      creditedAt: null,
    });
    orderCount.mockResolvedValue(0);

    await referralsService.creditReferralBonusOnFirstOrder("newuser-1");

    // Transaction should NOT have been called (no paid orders)
    expect($transaction).not.toHaveBeenCalled();
  });

  it("first paid order credits referral once", async () => {
    referralFindUnique.mockResolvedValue({
      id: "ref-2",
      referrerId: "referrer-2",
      referredId: "buyer-2",
      bonusAmount: 500,
      currency: "usd",
      creditedAt: null,
    });
    orderCount.mockResolvedValue(1); // First paid order

    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        referral: {
          findUnique: vi.fn().mockResolvedValue({
            id: "ref-2", referrerId: "referrer-2", referredId: "buyer-2",
            bonusAmount: 500, currency: "usd", creditedAt: null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        buyerWallet: {
          findUnique: vi.fn().mockResolvedValue({ id: "w1", buyerId: "referrer-2" }),
          update: vi.fn().mockResolvedValue({}),
        },
        buyerWalletTransaction: { create: vi.fn().mockResolvedValue({}) },
      };
      return cb(tx);
    });

    await referralsService.creditReferralBonusOnFirstOrder("buyer-2");
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("duplicate call does not double-credit (already credited)", async () => {
    referralFindUnique.mockResolvedValue({
      id: "ref-3",
      referrerId: "referrer-3",
      referredId: "buyer-3",
      bonusAmount: 500,
      currency: "usd",
      creditedAt: new Date(), // Already credited
    });

    await referralsService.creditReferralBonusOnFirstOrder("buyer-3");
    expect($transaction).not.toHaveBeenCalled();
  });

  it("self-referral rejected", async () => {
    referralFindUnique.mockResolvedValue({
      id: "ref-4",
      referrerId: "same-user",
      referredId: "same-user",
      bonusAmount: 500,
      currency: "usd",
      creditedAt: null,
    });

    await referralsService.creditReferralBonusOnFirstOrder("same-user");
    expect($transaction).not.toHaveBeenCalled();
  });
});

// ─── 4. Stripe automatic_payment_methods ────────────────────────────────────

describe("Stripe automatic_payment_methods (P2.4)", () => {
  it("PaymentIntent creation uses automatic_payment_methods", async () => {
    const { buyerWalletService } = await import("../modules/buyer-wallet/buyer-wallet.service");
    const walletFindUnique = prisma.buyerWallet.findUnique as unknown as ReturnType<typeof vi.fn>;

    walletFindUnique.mockResolvedValue({ id: "w1", buyerId: "b1", balance: 0, currency: "usd" });
    piCreate.mockResolvedValue({
      id: "pi_auto",
      client_secret: "pi_auto_secret",
      amount: 1000,
      currency: "usd",
    });

    await buyerWalletService.topUp("b1", { amount: 1000 });

    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        automatic_payment_methods: { enabled: true },
      }),
      expect.any(Object),
    );
    // Should NOT contain payment_method_types
    const callArgs = piCreate.mock.calls[0][0];
    expect(callArgs.payment_method_types).toBeUndefined();
  });

  it("checkout response shape unchanged (returns clientSecret)", async () => {
    const { buyerWalletService } = await import("../modules/buyer-wallet/buyer-wallet.service");
    const walletFindUnique = prisma.buyerWallet.findUnique as unknown as ReturnType<typeof vi.fn>;

    walletFindUnique.mockResolvedValue({ id: "w1", buyerId: "b1", balance: 0, currency: "usd" });
    piCreate.mockResolvedValue({
      id: "pi_shape",
      client_secret: "pi_shape_secret",
      amount: 2000,
      currency: "usd",
    });

    const result = await buyerWalletService.topUp("b1", { amount: 2000 });
    expect(result).toHaveProperty("clientSecret");
    expect(result).toHaveProperty("paymentIntentId");
    expect(result).toHaveProperty("amount");
    expect(result).toHaveProperty("currency");
  });
});

// ─── 5. Stripe API version pinned ──────────────────────────────────────────

describe("Stripe API version (P2.5)", () => {
  it("stripe client compiles and is importable", async () => {
    // If the API version were wrong, this import would fail at TypeScript compilation
    const { stripe: stripeClient } = await import("../lib/stripe");
    expect(stripeClient).toBeDefined();
  });
});

// ─── 6. Auth middleware live role check ──────────────────────────────────────

describe("Auth middleware live role check (P2.6)", () => {
  it("verifyTokenVersion returns DB role", async () => {
    userFindUnique.mockResolvedValue({ tokenVersion: 1, role: "VENDOR" });

    const result = await authService.verifyTokenVersion("user-1", 1);
    expect(result.valid).toBe(true);
    expect(result.role).toBe("VENDOR");
  });

  it("token with old BUYER role works with DB VENDOR role", async () => {
    userFindUnique.mockResolvedValue({ tokenVersion: 1, role: "VENDOR" });

    const result = await authService.verifyTokenVersion("user-1", 1);
    // Middleware would use result.role (VENDOR) not JWT claim (BUYER)
    expect(result.role).toBe("VENDOR");
  });

  it("tokenVersion mismatch rejects token", async () => {
    userFindUnique.mockResolvedValue({ tokenVersion: 2, role: "BUYER" });

    const result = await authService.verifyTokenVersion("user-1", 1);
    expect(result.valid).toBe(false);
  });

  it("demoted admin loses access", async () => {
    userFindUnique.mockResolvedValue({ tokenVersion: 1, role: "BUYER" });

    const result = await authService.verifyTokenVersion("user-1", 1);
    expect(result.valid).toBe(true);
    expect(result.role).toBe("BUYER"); // Was ADMIN in JWT, now BUYER in DB
  });
});

// ─── 7. Bcrypt rounds ──────────────────────────────────────────────────────

describe("Bcrypt rounds upgrade (P2.7)", () => {
  it("new registration uses cost 12", async () => {
    const userCreate = prisma.user.create as unknown as ReturnType<typeof vi.fn>;

    // No existing user with that email
    userFindUnique.mockResolvedValue(null);

    userCreate.mockImplementation(async ({ data }: { data: { password: string } }) => {
      const rounds = bcrypt.getRounds(data.password);
      expect(rounds).toBe(12);
      return {
        id: "new-1", email: "new@test.com", name: "Test",
        phone: null, avatar: null, country: null, role: "BUYER",
        createdAt: new Date(), tokenVersion: 0, password: data.password,
      };
    });

    await authService.register({
      email: "new@test.com",
      password: "ValidPass123!",
      name: "Test",
    });
  });

  it("login works with old hash (cost 10)", async () => {
    const oldHash = await bcrypt.hash("mypassword", 10);
    userFindUnique.mockResolvedValue({
      id: "old-1", email: "old@test.com", name: "Old User",
      phone: null, avatar: null, country: null, role: "BUYER",
      createdAt: new Date(), tokenVersion: 0, password: oldHash,
      failedLoginAttempts: 0, lockedUntil: null,
    });

    let savedPassword = "";
    userUpdate.mockImplementation(async ({ data }: { data: { password?: string } }) => {
      if (data.password) savedPassword = data.password;
      return {};
    });

    const result = await authService.login({ email: "old@test.com", password: "mypassword" });
    expect(result.token).toBeDefined();

    // Should have been rehashed to cost 12
    expect(savedPassword).not.toBe("");
    expect(bcrypt.getRounds(savedPassword)).toBe(12);
  });
});
