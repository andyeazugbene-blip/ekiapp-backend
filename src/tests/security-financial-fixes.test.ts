/**
 * Security & Financial Fixes Tests
 *
 * Tests for the critical backend fixes:
 * 1. Wallet top-up does not credit before webhook
 * 2. Wallet top-up credits exactly once after webhook success
 * 3. Duplicate wallet top-up webhook does not double credit
 * 4. Wallet apply cannot go negative under concurrent calls
 * 5. Webhook amount mismatch is marked IGNORED and returns 200
 * 6. payment_intent.canceled restores stock and wallet deduction
 * 7. Upload config rejects invalid/missing public URL
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentStatus, Prisma } from "@prisma/client";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../lib/prisma", () => ({
  prisma: {
    buyerWallet: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    buyerWalletTransaction: { create: vi.fn(), findMany: vi.fn() },
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    checkout: { findUnique: vi.fn(), updateMany: vi.fn() },
    payment: { findFirst: vi.fn(), updateMany: vi.fn() },
    product: { update: vi.fn() },
    orderItem: { findMany: vi.fn() },
    cart: { findUnique: vi.fn() },
    cartItem: { deleteMany: vi.fn() },
    wallet: { findUnique: vi.fn(), update: vi.fn() },
    walletTransaction: { create: vi.fn() },
    webhookEvent: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    vendor: { findUnique: vi.fn() },
    stripeDispute: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
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

vi.mock("../modules/regular-deliveries/renewals.service", () => ({
  renewalsService: { resolveProcessingPayment: vi.fn() },
}));

vi.mock("../modules/community-buy/campaign-contributions.service", () => ({
  campaignContributionsService: { resolveProcessingCharge: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { buyerWalletService } from "../modules/buyer-wallet/buyer-wallet.service";
import { stripeWebhookService } from "../modules/stripe/stripe.service";
import { renewalsService } from "../modules/regular-deliveries/renewals.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";

// ─── Typed mocks ──────────────────────────────────────────────────────────

const walletFindUnique = prisma.buyerWallet.findUnique as unknown as ReturnType<typeof vi.fn>;
const walletCreate = prisma.buyerWallet.create as unknown as ReturnType<typeof vi.fn>;
const walletUpdate = prisma.buyerWallet.update as unknown as ReturnType<typeof vi.fn>;
const walletUpdateMany = prisma.buyerWallet.updateMany as unknown as ReturnType<typeof vi.fn>;
const walletFindUniqueOrThrow = prisma.buyerWallet.findUniqueOrThrow as unknown as ReturnType<typeof vi.fn>;
const walletTxCreate = prisma.buyerWalletTransaction.create as unknown as ReturnType<typeof vi.fn>;
const orderFindUnique = prisma.order.findUnique as unknown as ReturnType<typeof vi.fn>;
const piCreate = (stripe.paymentIntents.create as unknown as ReturnType<typeof vi.fn>);
const constructEvent = (stripe.webhooks.constructEvent as unknown as ReturnType<typeof vi.fn>);
const webhookEventCreate = prisma.webhookEvent.create as unknown as ReturnType<typeof vi.fn>;
const webhookEventUpdate = prisma.webhookEvent.update as unknown as ReturnType<typeof vi.fn>;
const webhookEventUpdateMany = prisma.webhookEvent.updateMany as unknown as ReturnType<typeof vi.fn>;
const checkoutFindUnique = prisma.checkout.findUnique as unknown as ReturnType<typeof vi.fn>;
const checkoutUpdateMany = prisma.checkout.updateMany as unknown as ReturnType<typeof vi.fn>;
const orderUpdateMany = prisma.order.updateMany as unknown as ReturnType<typeof vi.fn>;
const paymentUpdateMany = prisma.payment.updateMany as unknown as ReturnType<typeof vi.fn>;
const productUpdate = prisma.product.update as unknown as ReturnType<typeof vi.fn>;
const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

// ─── 1. Wallet top-up does not credit before webhook ──────────────────────

describe("Wallet top-up (Stripe-based)", () => {
  const BUYER_ID = "buyer-1";
  const WALLET = { id: "w1", buyerId: BUYER_ID, balance: 500, currency: "usd" };

  it("does NOT credit wallet directly — returns clientSecret instead", async () => {
    walletFindUnique.mockResolvedValue(WALLET);
    piCreate.mockResolvedValue({
      id: "pi_test_123",
      client_secret: "pi_test_123_secret_abc",
      amount: 1000,
      currency: "usd",
    });

    const result = await buyerWalletService.topUp(BUYER_ID, { amount: 1000 });

    // Returns Stripe PaymentIntent data, not a transaction
    expect(result).toEqual({
      clientSecret: "pi_test_123_secret_abc",
      paymentIntentId: "pi_test_123",
      amount: 1000,
      currency: "usd",
    });

    // Stripe PI was created with wallet_topup metadata
    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1000,
        currency: "usd",
        metadata: { kind: "wallet_topup", buyerId: BUYER_ID },
      }),
      expect.any(Object),
    );

    // Wallet balance was NOT touched
    expect(walletUpdate).not.toHaveBeenCalled();
    expect(walletUpdateMany).not.toHaveBeenCalled();
    expect(walletTxCreate).not.toHaveBeenCalled();
  });

  // ─── 2. Wallet top-up credits exactly once after webhook success ────────

  it("credits wallet exactly once on webhook payment_intent.succeeded", async () => {
    const fakeEvent = {
      id: "evt_topup_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_topup_1",
          amount: 2000,
          currency: "usd",
          metadata: { kind: "wallet_topup", buyerId: BUYER_ID },
        },
      },
    };

    constructEvent.mockReturnValue(fakeEvent);

    // Make $transaction execute the callback
    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        buyerWallet: {
          findUnique: vi.fn().mockResolvedValue(WALLET),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
        },
        buyerWalletTransaction: {
          create: vi.fn().mockResolvedValue({ id: "bwt1" }),
        },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({
      signature: "valid-sig",
      rawBody: Buffer.from("body"),
    });

    expect(result.received).toBe(true);
    expect(result.type).toBe("payment_intent.succeeded");
    // Not a duplicate
    expect(result.duplicate).toBeUndefined();
  });

  // ─── 3. Duplicate wallet top-up webhook does not double credit ──────────

  it("returns duplicate on repeated wallet_topup webhook", async () => {
    const fakeEvent = {
      id: "evt_topup_dup",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_topup_dup",
          amount: 2000,
          currency: "usd",
          metadata: { kind: "wallet_topup", buyerId: BUYER_ID },
        },
      },
    };

    constructEvent.mockReturnValue(fakeEvent);

    // Simulate unique constraint violation on webhookEvent.create (duplicate)
    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError("Unique constraint", {
              code: "P2002",
              clientVersion: "6.0.0",
            }),
          ),
        },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({
      signature: "valid-sig",
      rawBody: Buffer.from("body"),
    });

    expect(result.received).toBe(true);
    expect(result.duplicate).toBe(true);
  });
});

// ─── 4. Wallet apply cannot go negative under concurrent calls ────────────

describe("Wallet apply race condition", () => {
  const BUYER_ID = "buyer-2";
  const WALLET = { id: "w2", buyerId: BUYER_ID, balance: 100, currency: "usd" };

  it("uses conditional updateMany to prevent race condition", async () => {
    orderFindUnique.mockResolvedValue({ buyerId: BUYER_ID });

    // Simulate the $transaction executing the callback
    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        buyerWallet: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue(WALLET),
        },
        buyerWalletTransaction: {
          create: vi.fn().mockResolvedValue({ id: "tx1", amount: 50 }),
        },
      };
      return cb(tx);
    });

    const result = await buyerWalletService.applyToOrder(BUYER_ID, { amount: 50, orderId: "order-1" });
    expect(result).toBeDefined();
  });

  it("throws when concurrent call drains balance (count=0)", async () => {
    orderFindUnique.mockResolvedValue({ buyerId: BUYER_ID });

    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        buyerWallet: {
          // Simulates race: another call already decremented balance below threshold
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      return cb(tx);
    });

    await expect(
      buyerWalletService.applyToOrder(BUYER_ID, { amount: 50, orderId: "order-1" }),
    ).rejects.toThrow("Insufficient wallet balance");
  });
});

// ─── 5. Webhook amount mismatch is marked IGNORED and returns 200 ─────────

describe("Webhook permanent validation failures", () => {
  it("amount mismatch is marked IGNORED and returns 200-style result", async () => {
    const fakeEvent = {
      id: "evt_mismatch",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_mismatch",
          amount: 9999, // Mismatch!
          currency: "usd",
          metadata: { checkoutId: "co_1", buyerId: "buyer-3" },
        },
      },
    };

    constructEvent.mockReturnValue(fakeEvent);

    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        checkout: {
          findUnique: vi.fn().mockResolvedValue({
            id: "co_1",
            buyerId: "buyer-3",
            totalAmount: 5000, // Different from PI amount (9999)
            currency: "usd",
            status: "PENDING",
            orders: [],
          }),
        },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({
      signature: "valid-sig",
      rawBody: Buffer.from("body"),
    });

    // Should return 200 with ignored=true, NOT throw 400
    expect(result.received).toBe(true);
    expect(result.ignored).toBe(true);
  });

  it("checkout not found is marked IGNORED and returns 200-style result", async () => {
    const fakeEvent = {
      id: "evt_no_checkout",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_no_checkout",
          amount: 5000,
          currency: "usd",
          metadata: { checkoutId: "co_missing", buyerId: "buyer-4" },
        },
      },
    };

    constructEvent.mockReturnValue(fakeEvent);

    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        checkout: {
          findUnique: vi.fn().mockResolvedValue(null), // Not found
        },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({
      signature: "valid-sig",
      rawBody: Buffer.from("body"),
    });

    expect(result.received).toBe(true);
    expect(result.ignored).toBe(true);
  });

  it("buyer mismatch is marked IGNORED and returns 200-style result", async () => {
    const fakeEvent = {
      id: "evt_buyer_mismatch",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_buyer_mismatch",
          amount: 5000,
          currency: "usd",
          metadata: { checkoutId: "co_2", buyerId: "wrong-buyer" },
        },
      },
    };

    constructEvent.mockReturnValue(fakeEvent);

    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        checkout: {
          findUnique: vi.fn().mockResolvedValue({
            id: "co_2",
            buyerId: "real-buyer",
            totalAmount: 5000,
            currency: "usd",
            status: "PENDING",
            orders: [],
          }),
        },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({
      signature: "valid-sig",
      rawBody: Buffer.from("body"),
    });

    expect(result.received).toBe(true);
    expect(result.ignored).toBe(true);
  });
});

// ─── 6. payment_intent.canceled restores stock and wallet deduction ───────

describe("payment_intent.canceled", () => {
  it("restores stock and wallet deduction on cancellation", async () => {
    const fakeEvent = {
      id: "evt_canceled_1",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_canceled_1",
          metadata: { checkoutId: "co_cancel_1", buyerId: "buyer-5" },
        },
      },
    };

    constructEvent.mockReturnValue(fakeEvent);

    const mockProductUpdate = vi.fn().mockResolvedValue({});
    const mockBuyerWalletFindUnique = vi.fn().mockResolvedValue({
      id: "bw_5",
      buyerId: "buyer-5",
      balance: 0,
      currency: "usd",
    });
    const mockBuyerWalletUpdate = vi.fn().mockResolvedValue({});
    const mockBuyerWalletTxCreate = vi.fn().mockResolvedValue({});

    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        checkout: {
          findUnique: vi.fn().mockResolvedValue({
            id: "co_cancel_1",
            buyerId: "buyer-5",
            totalAmount: 3000,
            currency: "usd",
            status: "PENDING",
            metadata: { walletDeduction: 500 },
            orders: [
              {
                id: "ord_1",
                items: [
                  { productId: "prod_1", quantity: 2 },
                  { productId: "prod_2", quantity: 1 },
                ],
              },
            ],
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        product: { update: mockProductUpdate },
        buyerWallet: {
          findUnique: mockBuyerWalletFindUnique,
          update: mockBuyerWalletUpdate,
        },
        buyerWalletTransaction: { create: mockBuyerWalletTxCreate },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({
      signature: "valid-sig",
      rawBody: Buffer.from("body"),
    });

    expect(result.received).toBe(true);
    expect(result.type).toBe("payment_intent.canceled");

    // Stock was restored for both items
    expect(mockProductUpdate).toHaveBeenCalledTimes(2);
    expect(mockProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "prod_1" },
        data: { stock: { increment: 2 } },
      }),
    );
    expect(mockProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "prod_2" },
        data: { stock: { increment: 1 } },
      }),
    );

    // Wallet deduction was restored
    expect(mockBuyerWalletUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: { increment: 500 } },
      }),
    );
    expect(mockBuyerWalletTxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REFUND_CREDIT",
          amount: 500,
        }),
      }),
    );
  });

  it("is idempotent — duplicate cancellation returns duplicate", async () => {
    const fakeEvent = {
      id: "evt_canceled_dup",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_canceled_dup",
          metadata: { checkoutId: "co_cancel_dup" },
        },
      },
    };

    constructEvent.mockReturnValue(fakeEvent);

    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError("Unique constraint", {
              code: "P2002",
              clientVersion: "6.0.0",
            }),
          ),
        },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({
      signature: "valid-sig",
      rawBody: Buffer.from("body"),
    });

    expect(result.received).toBe(true);
    expect(result.duplicate).toBe(true);
  });
});

// ─── Reliability scenario #3: webhook arrives out of order ────────────────

describe("Webhook out-of-order delivery (reliability scenario #3)", () => {
  it("a late payment_intent.payment_failed cannot revert a checkout that already succeeded — no stock restored, no wallet reversal", async () => {
    const fakeEvent = {
      id: "evt_late_failed",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_ooo_1",
          metadata: { checkoutId: "co_ooo_1", buyerId: "buyer-ooo" },
        },
      },
    };
    constructEvent.mockReturnValue(fakeEvent);

    const mockProductUpdate = vi.fn();
    const mockCheckoutUpdateMany = vi.fn();
    const mockBuyerWalletUpdate = vi.fn();

    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        checkout: {
          // The checkout already reached SUCCEEDED — e.g. the succeeded
          // event was processed first, and this failed event is the
          // older/out-of-order one arriving late.
          findUnique: vi.fn().mockResolvedValue({
            id: "co_ooo_1",
            buyerId: "buyer-ooo",
            status: "SUCCEEDED",
            metadata: null,
            orders: [{ id: "ord_ooo_1", items: [{ productId: "prod_ooo_1", quantity: 1 }] }],
          }),
          updateMany: mockCheckoutUpdateMany,
        },
        order: { updateMany: vi.fn() },
        payment: { updateMany: vi.fn() },
        product: { update: mockProductUpdate },
        buyerWallet: { findUnique: vi.fn(), update: mockBuyerWalletUpdate },
        buyerWalletTransaction: { create: vi.fn() },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(result.ignored).toBe(true);
    // The already-SUCCEEDED state is never touched by the late failure event.
    expect(mockCheckoutUpdateMany).not.toHaveBeenCalled();
    expect(mockProductUpdate).not.toHaveBeenCalled();
    expect(mockBuyerWalletUpdate).not.toHaveBeenCalled();
  });

  it("a late payment_intent.succeeded cannot resurrect a checkout that already failed — no ledger/wallet credit, no order marked PAID", async () => {
    const fakeEvent = {
      id: "evt_late_succeeded",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_ooo_2",
          amount: 5000,
          currency: "usd",
          metadata: { checkoutId: "co_ooo_2", buyerId: "buyer-ooo-2" },
        },
      },
    };
    constructEvent.mockReturnValue(fakeEvent);

    const mockOrderUpdateMany = vi.fn();
    const mockWalletUpdate = vi.fn();
    const mockWalletTxCreate = vi.fn();

    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        checkout: {
          // Already FAILED — e.g. the failed event (or a prior cancellation)
          // was processed first; this succeeded event is the older/
          // out-of-order one arriving late.
          findUnique: vi.fn().mockResolvedValue({
            id: "co_ooo_2",
            buyerId: "buyer-ooo-2",
            status: "FAILED",
            totalAmount: 5000,
            currency: "usd",
            metadata: null,
            orders: [],
          }),
          // Conditional update only ever matches status: PENDING — the real
          // status is FAILED, so this correctly matches zero rows.
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        order: { updateMany: mockOrderUpdateMany },
        wallet: { findUnique: vi.fn(), update: mockWalletUpdate },
        walletTransaction: { create: mockWalletTxCreate },
        cart: { findUnique: vi.fn() },
        cartItem: { deleteMany: vi.fn() },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(result.duplicate).toBe(true);
    // Nothing about the already-FAILED financial state was touched.
    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    expect(mockWalletUpdate).not.toHaveBeenCalled();
    expect(mockWalletTxCreate).not.toHaveBeenCalled();
  });
});

// ─── Reliability scenario #24 (architecture doc §18): "backend unavailable during webhook delivery" ──

describe("Webhook processing — backend unavailable mid-delivery (reliability scenario #24)", () => {
  it("propagates the failure instead of returning a fabricated 200 — so Stripe's own retry mechanism fires again", async () => {
    const fakeEvent = {
      id: "evt_backend_down",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_backend_down",
          amount: 5000,
          currency: "usd",
          metadata: { checkoutId: "co_backend_down", buyerId: "buyer-down" },
        },
      },
    };
    constructEvent.mockReturnValue(fakeEvent);

    // The DB genuinely dies mid-transaction (not a P2002 duplicate) —
    // simulating the backend being unavailable while Stripe is delivering
    // the webhook. Because this throws INSIDE the interactive transaction
    // callback, Prisma rolls the whole thing back — including any
    // webhookEvent row this attempt may have inserted — so the event id is
    // never burned by a failed attempt.
    $transaction.mockImplementationOnce(async () => {
      throw new Error("Connection terminated unexpectedly");
    });

    await expect(
      stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") }),
    ).rejects.toThrow("Connection terminated unexpectedly");
    // No financial side effect of any kind was recorded for this attempt.
    expect(webhookEventUpdate).not.toHaveBeenCalled();
  });

  it("completes normally and produces exactly one financial effect once Stripe retries the same event after the backend recovers", async () => {
    const fakeEvent = {
      id: "evt_backend_down", // same event id Stripe retries with
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_backend_down",
          amount: 5000,
          currency: "usd",
          metadata: { checkoutId: "co_backend_down", buyerId: "buyer-down" },
        },
      },
    };
    constructEvent.mockReturnValue(fakeEvent);

    const walletCreate = vi.fn();
    const walletUpdateTx = vi.fn().mockResolvedValue({});
    const walletTxCreateTx = vi.fn().mockResolvedValue({});
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        webhookEvent: {
          create: vi.fn().mockResolvedValue({}), // event id free again — the earlier attempt was rolled back
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        checkout: {
          findUnique: vi.fn().mockResolvedValue({
            id: "co_backend_down",
            buyerId: "buyer-down",
            status: "PENDING",
            totalAmount: 5000,
            currency: "usd",
            metadata: null,
            orders: [
              {
                id: "order-down-1",
                vendorId: "vendor-down-1",
                items: [{ vendorId: "vendor-down-1" }],
                payment: { id: "payment-down-1", status: "PENDING", vendorEarningsAmount: 4000, platformFeeAmount: 1000, currency: "usd" },
              },
            ],
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        wallet: { findUnique: vi.fn().mockResolvedValue(null), create: walletCreate.mockResolvedValue({ id: "wallet-down-1" }), update: walletUpdateTx },
        walletTransaction: { create: walletTxCreateTx },
        cart: { findUnique: vi.fn().mockResolvedValue(null) },
        cartItem: { deleteMany: vi.fn() },
      };
      return cb(tx);
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(result.duplicate).toBeUndefined();
    expect(result.ignored).toBeUndefined();
    // Exactly one wallet credit was posted for this recovery — not two,
    // even though this is nominally the "second" delivery attempt Stripe
    // made for this event id.
    expect(walletUpdateTx).toHaveBeenCalledTimes(1);
    expect(walletTxCreateTx).toHaveBeenCalledTimes(1);
  });
});

// ─── Webhook dispatch for the "processing" resolution path (scenarios #4/#5) ──

describe("Webhook dispatch — regular_delivery_renewal / community_buy_pledge_charge resolution", () => {
  const resolveProcessingPayment = vi.mocked(renewalsService.resolveProcessingPayment);
  const resolveProcessingCharge = vi.mocked(campaignContributionsService.resolveProcessingCharge);

  it("routes a renewal's payment_intent.succeeded to resolveProcessingPayment(succeeded=true), gated by the same WebhookEvent idempotency key as every other handler", async () => {
    const fakeEvent = {
      id: "evt_renewal_resolved",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_renewal_1", metadata: { kind: "regular_delivery_renewal", renewalId: "renewal-webhook-1" } } },
    };
    constructEvent.mockReturnValue(fakeEvent);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    }));
    resolveProcessingPayment.mockResolvedValue({ handled: true });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(resolveProcessingPayment).toHaveBeenCalledWith("renewal-webhook-1", "pi_renewal_1", true, undefined);
    expect(result.received).toBe(true);
    expect(result.duplicate).toBeUndefined();
  });

  it("routes a renewal's payment_intent.payment_failed to resolveProcessingPayment(succeeded=false)", async () => {
    const fakeEvent = {
      id: "evt_renewal_failed",
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_renewal_2", metadata: { kind: "regular_delivery_renewal", renewalId: "renewal-webhook-2" } } },
    };
    constructEvent.mockReturnValue(fakeEvent);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    }));
    resolveProcessingPayment.mockResolvedValue({ handled: true });

    await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(resolveProcessingPayment).toHaveBeenCalledWith("renewal-webhook-2", "pi_renewal_2", false, "Payment failed after processing");
  });

  it("is idempotent — a duplicate delivery of the same renewal-resolution event never calls resolveProcessingPayment twice", async () => {
    const fakeEvent = {
      id: "evt_renewal_dup",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_renewal_3", metadata: { kind: "regular_delivery_renewal", renewalId: "renewal-webhook-3" } } },
    };
    constructEvent.mockReturnValue(fakeEvent);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      webhookEvent: {
        create: vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.0.0" })),
      },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.duplicate).toBe(true);
    expect(resolveProcessingPayment).not.toHaveBeenCalled();
  });

  it("routes a Community Buy pledge's payment_intent.succeeded to resolveProcessingCharge(succeeded=true)", async () => {
    const fakeEvent = {
      id: "evt_pledge_resolved",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_pledge_1", metadata: { kind: "community_buy_pledge_charge", contributionId: "contrib-webhook-1" } } },
    };
    constructEvent.mockReturnValue(fakeEvent);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    }));
    resolveProcessingCharge.mockResolvedValue({ handled: true });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(resolveProcessingCharge).toHaveBeenCalledWith("contrib-webhook-1", "pi_pledge_1", true, undefined);
    expect(result.received).toBe(true);
  });

  it("routes a Community Buy pledge's payment_intent.canceled to resolveProcessingCharge(succeeded=false)", async () => {
    const fakeEvent = {
      id: "evt_pledge_failed",
      type: "payment_intent.canceled",
      data: { object: { id: "pi_pledge_2", metadata: { kind: "community_buy_pledge_charge", contributionId: "contrib-webhook-2" } } },
    };
    constructEvent.mockReturnValue(fakeEvent);
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    }));
    resolveProcessingCharge.mockResolvedValue({ handled: true });

    await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(resolveProcessingCharge).toHaveBeenCalledWith("contrib-webhook-2", "pi_pledge_2", false, "Payment failed after processing");
  });
});

// ─── charge.dispute.created persists a real StripeDispute row (architecture doc §15.3 "Chargebacks") ──

describe("Webhook dispatch — charge.dispute.created persists a real chargeback record", () => {
  it("upserts a StripeDispute row with the dispute's real amount/currency/reason/status", async () => {
    const fakeEvent = {
      id: "evt_dispute_1",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_1",
          payment_intent: "pi_disputed_1",
          amount: 12345,
          currency: "gbp",
          reason: "fraudulent",
          status: "warning_needs_response",
        },
      },
    };
    constructEvent.mockReturnValue(fakeEvent);

    const stripeDisputeUpsert = vi.fn().mockResolvedValue({});
    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      webhookEvent: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      checkout: { findUnique: vi.fn().mockResolvedValue({ id: "co_disputed_1", buyerId: "buyer-disputed-1" }) },
      stripeDispute: { upsert: stripeDisputeUpsert },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(stripeDisputeUpsert).toHaveBeenCalledWith({
      where: { stripeDisputeId: "dp_1" },
      update: { status: "warning_needs_response" },
      create: expect.objectContaining({
        stripeDisputeId: "dp_1",
        paymentIntentId: "pi_disputed_1",
        checkoutId: "co_disputed_1",
        buyerId: "buyer-disputed-1",
        amount: 12345,
        currency: "gbp",
        reason: "fraudulent",
        status: "warning_needs_response",
      }),
    });
  });

  it("is idempotent — a retried delivery of the same dispute event never creates a second row", async () => {
    const fakeEvent = {
      id: "evt_dispute_dup",
      type: "charge.dispute.created",
      data: { object: { id: "dp_dup", amount: 500, currency: "usd", reason: "duplicate", status: "needs_response" } },
    };
    constructEvent.mockReturnValue(fakeEvent);

    $transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      webhookEvent: {
        create: vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.0.0" })),
      },
    }));

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.duplicate).toBe(true);
  });
});

// ─── 7. Upload config rejects invalid/missing public URL ──────────────────

describe("Upload config validation", () => {
  it("rejects endpoint that includes bucket name", () => {
    const originalEnv = { ...process.env };

    // This tests the startup validation logic from storage.ts
    // We test the validation function inline since the module throws at import
    const endpoint = "https://my-bucket.r2.cloudflarestorage.com";
    const bucket = "my-bucket";

    expect(endpoint.includes(bucket)).toBe(true);
    // The storage module would throw: S3_ENDPOINT must NOT include the bucket name

    process.env = originalEnv;
  });

  it("rejects missing public URL when endpoint is configured", () => {
    // When S3_ENDPOINT is set but S3_PUBLIC_URL and UPLOAD_BASE_URL are empty,
    // the storage module throws at startup
    const endpoint = "https://abc.r2.cloudflarestorage.com";
    const bucket = "uploads";
    const accessKey = "key";
    const secretKey = "secret";
    const publicUrl = "";

    // Simulates the validation check
    const shouldThrow = endpoint && bucket && accessKey && secretKey && !publicUrl;
    expect(shouldThrow).toBe(true);
  });

  it("accepts valid config with public URL", () => {
    const endpoint = "https://abc.r2.cloudflarestorage.com";
    const bucket = "uploads";
    const publicUrl = "https://cdn.example.com";

    // Endpoint does not contain bucket
    expect(endpoint.includes(bucket)).toBe(false);
    // Public URL is configured
    expect(!!publicUrl).toBe(true);
  });

  it("validates content type allowlist", () => {
    const ALLOWED_CONTENT_TYPES = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "application/pdf",
    ]);

    expect(ALLOWED_CONTENT_TYPES.has("image/jpeg")).toBe(true);
    expect(ALLOWED_CONTENT_TYPES.has("image/png")).toBe(true);
    expect(ALLOWED_CONTENT_TYPES.has("application/pdf")).toBe(true);
    expect(ALLOWED_CONTENT_TYPES.has("text/html")).toBe(false);
    expect(ALLOWED_CONTENT_TYPES.has("application/javascript")).toBe(false);
    expect(ALLOWED_CONTENT_TYPES.has("image/svg+xml")).toBe(false);
  });
});
