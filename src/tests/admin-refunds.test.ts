/**
 * Tests for adminRefundOrder — provider branching, idempotency, duplicate guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// Mock prisma + stripe + paystack at the paths the controller imports them from.
// Path is relative to this test file (src/tests/) → "../lib/..." resolves to src/lib/...
vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn(), update: vi.fn() },
    paystackTransaction: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    // Four-eyes gate (admin-approvals.service.ts) checks for a configured
    // rule before every refund now — null (no rule) means it stays
    // ungated, exactly matching this file's pre-four-eyes behavior.
    adminApprovalRule: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: {
    refunds: { create: vi.fn() },
  },
}));

vi.mock("../lib/paystack", () => ({
  paystack: {
    refundTransaction: vi.fn(),
    isConfigured: vi.fn(() => true),
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: {
    enqueue: vi.fn().mockResolvedValue(undefined),
  },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { paystack } from "../lib/paystack";
import { notificationsService } from "../modules/notifications/notifications.service";

import { adminRefundOrder } from "../modules/admin/admin-refunds.controller";

const mockedPrisma = vi.mocked(prisma, true);
const mockedStripeRefundCreate = vi.mocked(stripe.refunds.create);
const mockedPaystackRefund = vi.mocked(paystack.refundTransaction);
const mockedNotifyEnqueue = vi.mocked(notificationsService.enqueue);

function createMockReq(orderId: string, body: Record<string, unknown> = {}): Request {
  return {
    user: { id: "admin-1", role: "ADMIN", email: "admin@test.com" },
    params: { id: orderId },
    body,
    headers: {},
  } as unknown as Request;
}

function createMockRes(): Response & { statusCode: number; data: unknown } {
  const res = {
    statusCode: 0,
    data: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.data = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; data: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction simply runs the callback with the mocked prisma client
  mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockedPrisma));
  mockedPrisma.order.update.mockResolvedValue({} as never);
  mockedPrisma.paystackTransaction.update.mockResolvedValue({} as never);
  mockedPrisma.auditLog.create.mockResolvedValue({} as never);
});

describe("adminRefundOrder — provider branching", () => {
  it("STRIPE: calls stripe.refunds.create with idempotencyKey and marks order REFUNDED", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "PAID",
      totalAmount: 10000,
      currency: "eur",
      checkoutCurrency: null,
      exchangeRate: null,
      payment: {
        id: "pay-1",
        stripePaymentIntentId: "pi_123",
        status: "SUCCEEDED",
        amount: 10000,
        provider: "stripe",
      },
      paystackTransaction: null,
    } as never);

    mockedStripeRefundCreate.mockResolvedValue({
      id: "re_abc",
      amount: 10000,
      status: "succeeded",
    } as never);

    const req = createMockReq("ord-1", { amount: 10000, reason: "duplicate" });
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    expect(mockedStripeRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockedPaystackRefund).not.toHaveBeenCalled();

    // Confirm idempotency key shape
    const [, options] = mockedStripeRefundCreate.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({ idempotencyKey: "refund:ord-1:10000" }));

    // Confirm payload
    const [payload] = mockedStripeRefundCreate.mock.calls[0];
    expect(payload).toEqual(expect.objectContaining({
      payment_intent: "pi_123",
      amount: 10000,
      reason: "duplicate",
    }));

    // Order marked REFUNDED + audit log
    expect(mockedPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ord-1" }, data: { status: "REFUNDED" } }),
    );
    expect(mockedPrisma.auditLog.create).toHaveBeenCalled();

    expect(res.statusCode).toBe(202);
    expect((res.data as Record<string, unknown>).provider).toBe("stripe");
  });

  it("STRIPE: full refund (no amount) defaults to the order's own native total, expressed explicitly (never omitted)", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-2",
      status: "PAID",
      totalAmount: 5000,
      currency: "eur",
      checkoutCurrency: null,
      exchangeRate: null,
      payment: {
        id: "pay-2",
        stripePaymentIntentId: "pi_456",
        status: "SUCCEEDED",
        amount: 5000,
        provider: "stripe",
      },
      paystackTransaction: null,
    } as never);

    mockedStripeRefundCreate.mockResolvedValue({
      id: "re_def",
      amount: 5000,
      status: "succeeded",
    } as never);

    const req = createMockReq("ord-2", { reason: "fraudulent" });
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    // Omitting `amount` must never omit it from the Stripe call — this
    // order's PaymentIntent may be shared with other vendors' orders in the
    // same checkout, so an omitted Stripe amount would refund ALL of them.
    const [payload, options] = mockedStripeRefundCreate.mock.calls[0];
    expect(payload).toEqual(expect.objectContaining({ amount: 5000 }));
    expect(options).toEqual(expect.objectContaining({ idempotencyKey: "refund:ord-2:5000" }));
  });

  it("STRIPE: a normalized order (native currency differs from the checkout/PaymentIntent currency) refunds the amount actually charged, using the stored rate — never the native number taken at face value", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-10",
      status: "PAID",
      totalAmount: 1000, // native EUR-cents
      currency: "eur",
      checkoutCurrency: "usd", // buyer's checkout was charged in USD
      exchangeRate: 1.0940, // same snapshot taken at checkout time (1 EUR = 1.094 USD here)
      payment: {
        id: "pay-10",
        stripePaymentIntentId: "pi_shared",
        status: "SUCCEEDED",
        amount: 1094, // this order's contribution in USD-cents, as actually charged
        provider: "stripe",
      },
      paystackTransaction: null,
    } as never);

    mockedStripeRefundCreate.mockResolvedValue({
      id: "re_ghi",
      amount: 1094,
      status: "succeeded",
    } as never);

    const req = createMockReq("ord-10", { reason: "requested_by_customer" });
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    const [payload] = mockedStripeRefundCreate.mock.calls[0];
    // Stripe must be told to refund 1094 (USD-cents, the PI's real
    // currency) — refunding 1000 (the native EUR-cents number) would be a
    // silent under-refund in the wrong currency's terms.
    expect(payload).toEqual(expect.objectContaining({ payment_intent: "pi_shared", amount: 1094 }));
    // The response shown to the admin stays in the order's own native
    // currency/amount — never the converted PaymentIntent figure — so it
    // matches every other amount already displayed for this order.
    expect((res.data as Record<string, unknown>).amount).toBe(1000);
    expect((res.data as Record<string, unknown>).currency).toBe("eur");
  });

  it("STRIPE: a partial refund on a normalized order is validated against the native total and converted with the same stored rate", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-11",
      status: "PAID",
      totalAmount: 1000, // native EUR-cents
      currency: "eur",
      checkoutCurrency: "usd",
      exchangeRate: 1.0940,
      payment: {
        id: "pay-11",
        stripePaymentIntentId: "pi_shared_2",
        status: "SUCCEEDED",
        amount: 1094,
        provider: "stripe",
      },
      paystackTransaction: null,
    } as never);

    mockedStripeRefundCreate.mockResolvedValue({ id: "re_jkl", amount: 547, status: "succeeded" } as never);

    // Admin enters 500 (native EUR-cents — half the order) — never a
    // pre-converted USD figure.
    const req = createMockReq("ord-11", { amount: 500, reason: "requested_by_customer" });
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    const [payload] = mockedStripeRefundCreate.mock.calls[0];
    // round(500 * 1.0940) = 547 USD-cents.
    expect(payload).toEqual(expect.objectContaining({ amount: 547 }));
    expect((res.data as Record<string, unknown>).amount).toBe(500);
  });

  it("STRIPE: a partial refund on a single-currency order (no conversion) passes the native amount straight through", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-13",
      status: "PAID",
      totalAmount: 4000,
      currency: "gbp",
      checkoutCurrency: null,
      exchangeRate: null,
      payment: { id: "pay-13", stripePaymentIntentId: "pi_partial", status: "SUCCEEDED", amount: 4000, provider: "stripe" },
      paystackTransaction: null,
    } as never);

    mockedStripeRefundCreate.mockResolvedValue({ id: "re_mno", amount: 1500, status: "succeeded" } as never);

    const req = createMockReq("ord-13", { amount: 1500, reason: "requested_by_customer" });
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    const [payload] = mockedStripeRefundCreate.mock.calls[0];
    expect(payload).toEqual(expect.objectContaining({ amount: 1500 }));
    expect((res.data as Record<string, unknown>).amount).toBe(1500);
    expect((res.data as Record<string, unknown>).currency).toBe("gbp");
  });

  it("STRIPE: rejects a refund amount greater than the order's own native total", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-12",
      status: "PAID",
      totalAmount: 1000,
      currency: "eur",
      checkoutCurrency: null,
      exchangeRate: null,
      payment: { id: "pay-12", stripePaymentIntentId: "pi_over", status: "SUCCEEDED", amount: 1000, provider: "stripe" },
      paystackTransaction: null,
    } as never);

    const req = createMockReq("ord-12", { amount: 5000 });
    const res = createMockRes();

    await expect(adminRefundOrder(req, res as unknown as Response)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("cannot exceed"),
    });
    expect(mockedStripeRefundCreate).not.toHaveBeenCalled();
  });

  it("PAYSTACK: calls paystack.refundTransaction and marks order REFUNDED + tx REVERSED", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-3",
      buyerId: "buyer-3",
      status: "PAID",
      totalAmount: 20000,
      currency: "ngn",
      payment: null,
      paystackTransaction: {
        reference: "psk-ref-789",
        status: "SUCCESS",
        amount: 20000,
      },
    } as never);

    mockedPaystackRefund.mockResolvedValue(undefined as never);

    const req = createMockReq("ord-3", { amount: 20000 });
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    expect(mockedPaystackRefund).toHaveBeenCalledTimes(1);
    expect(mockedPaystackRefund).toHaveBeenCalledWith("psk-ref-789", 20000);
    expect(mockedStripeRefundCreate).not.toHaveBeenCalled();

    expect(mockedPrisma.paystackTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reference: "psk-ref-789" },
        data: { status: "REVERSED" },
      }),
    );
    expect(mockedPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ord-3" }, data: { status: "REFUNDED" } }),
    );

    expect(res.statusCode).toBe(202);
    expect((res.data as Record<string, unknown>).provider).toBe("paystack");
  });

  it("PAYSTACK: notifies the buyer — Paystack refunds have no webhook confirmation, so the buyer would otherwise never learn their refund happened", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-9",
      buyerId: "buyer-9",
      status: "PAID",
      totalAmount: 5000,
      currency: "ngn",
      payment: null,
      paystackTransaction: {
        reference: "psk-ref-999",
        status: "SUCCESS",
        amount: 5000,
      },
    } as never);

    mockedPaystackRefund.mockResolvedValue(undefined as never);

    const req = createMockReq("ord-9");
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    expect(mockedNotifyEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "buyer-9",
        data: expect.objectContaining({ type: "order_refunded", orderIds: ["ord-9"] }),
      }),
    );
  });

  it("DUPLICATE: returns 409 when order already REFUNDED", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-4",
      status: "REFUNDED",
      payment: {
        id: "pay-4",
        stripePaymentIntentId: "pi_xyz",
        status: "SUCCEEDED",
        amount: 1000,
        provider: "stripe",
      },
      paystackTransaction: null,
    } as never);

    const req = createMockReq("ord-4");
    const res = createMockRes();

    await expect(adminRefundOrder(req, res as unknown as Response)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already refunded"),
    });

    expect(mockedStripeRefundCreate).not.toHaveBeenCalled();
    expect(mockedPaystackRefund).not.toHaveBeenCalled();
  });

  it("ORDER NOT FOUND: returns 404", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue(null);

    const req = createMockReq("does-not-exist");
    const res = createMockRes();

    await expect(adminRefundOrder(req, res as unknown as Response)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("STRIPE: rejects when payment is not SUCCEEDED", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-5",
      status: "PAID",
      payment: {
        id: "pay-5",
        stripePaymentIntentId: "pi_pending",
        status: "PENDING",
        amount: 1000,
        provider: "stripe",
      },
      paystackTransaction: null,
    } as never);

    const req = createMockReq("ord-5");
    const res = createMockRes();

    await expect(adminRefundOrder(req, res as unknown as Response)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("succeeded"),
    });
  });

  it("PAYSTACK: rejects when paystack tx is not SUCCESS", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-6",
      status: "PAID",
      payment: null,
      paystackTransaction: {
        reference: "psk-ref-pending",
        status: "PENDING",
        amount: 1000,
      },
    } as never);

    const req = createMockReq("ord-6");
    const res = createMockRes();

    await expect(adminRefundOrder(req, res as unknown as Response)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Paystack"),
    });
  });

  it("STRIPE refund API failure: returns controlled 502", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-7",
      status: "PAID",
      totalAmount: 1000,
      currency: "eur",
      checkoutCurrency: null,
      exchangeRate: null,
      payment: {
        id: "pay-7",
        stripePaymentIntentId: "pi_fail",
        status: "SUCCEEDED",
        amount: 1000,
        provider: "stripe",
      },
      paystackTransaction: null,
    } as never);

    mockedStripeRefundCreate.mockRejectedValue(new Error("Stripe API down"));

    const req = createMockReq("ord-7");
    const res = createMockRes();

    await expect(adminRefundOrder(req, res as unknown as Response)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("Stripe refund failed"),
    });
  });

  it("four-eyes: a configured threshold gates a large refund — creates a pending approval instead of executing", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-8",
      status: "PAID",
      totalAmount: 100000,
      payment: { id: "pay-8", stripePaymentIntentId: "pi_large", status: "SUCCEEDED", amount: 100000, provider: "stripe" },
      paystackTransaction: null,
    } as never);
    mockedPrisma.adminApprovalRule.findUnique.mockResolvedValueOnce({ actionType: "order.refund.large", thresholdAmount: 50000, enabled: true } as never);
    const mockedApproval = { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "appr-refund-1", status: "PENDING" }) };
    (mockedPrisma as unknown as { adminApproval: typeof mockedApproval }).adminApproval = mockedApproval;

    const req = createMockReq("ord-8", { amount: 100000, reason: "requested_by_customer" });
    const res = createMockRes();

    await adminRefundOrder(req, res as unknown as Response);

    expect(res.statusCode).toBe(202);
    expect((res.data as { pendingApproval?: unknown }).pendingApproval).toBeTruthy();
    expect(mockedStripeRefundCreate).not.toHaveBeenCalled(); // gated — never actually charged/refunded
  });
});
