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

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { paystack } from "../lib/paystack";

import { adminRefundOrder } from "../modules/admin/admin-refunds.controller";

const mockedPrisma = vi.mocked(prisma, true);
const mockedStripeRefundCreate = vi.mocked(stripe.refunds.create);
const mockedPaystackRefund = vi.mocked(paystack.refundTransaction);

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

  it("STRIPE: full refund (no amount) uses idempotencyKey suffix 'full'", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-2",
      status: "PAID",
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

    const [, options] = mockedStripeRefundCreate.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({ idempotencyKey: "refund:ord-2:full" }));
  });

  it("PAYSTACK: calls paystack.refundTransaction and marks order REFUNDED + tx REVERSED", async () => {
    mockedPrisma.order.findUnique.mockResolvedValue({
      id: "ord-3",
      status: "PAID",
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
});
