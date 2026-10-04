/**
 * Handbook 14.8 / B4: a partial refund must not close the order, later refunds
 * count against the order total, and a replay with the same idempotency key
 * must not create a second refund.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn(), update: vi.fn() },
    paystackTransaction: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    refund: {
      aggregate: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
    },
  },
}));
vi.mock("../lib/stripe", () => ({ stripe: { refunds: { create: vi.fn() } } }));
vi.mock("../lib/paystack", () => ({ paystack: { refundTransaction: vi.fn(), isConfigured: vi.fn(() => true) } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { executeOrderRefund } from "../modules/admin/admin-refunds.controller";

const m = vi.mocked(prisma, true);
const create = vi.mocked(stripe.refunds.create);

const order = {
  id: "ord-1", status: "PAID", totalAmount: 10000, currency: "eur", checkoutCurrency: null, exchangeRate: null,
  payment: { id: "pay-1", stripePaymentIntentId: "pi_1", status: "SUCCEEDED", amount: 10000, provider: "stripe" },
  paystackTransaction: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.order.findUnique.mockResolvedValue(order as never);
  m.refund.count.mockResolvedValue(0 as never);
  m.refund.create.mockResolvedValue({ id: "rr-1" } as never);
  m.refund.update.mockResolvedValue({} as never);
});

describe("cumulative refunds", () => {
  it("a partial refund leaves the order open (status NOT flipped)", async () => {
    m.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 0 } } as never);
    create.mockResolvedValue({ id: "re_1", amount: 2500, status: "succeeded" } as never);

    await executeOrderRefund("ord-1", "admin-1", 2500, "Partial refund for a damaged item");

    expect(m.order.update).not.toHaveBeenCalled();
    expect(m.refund.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED", providerRefundId: "re_1" }) }));
  });

  it("the refund that brings the cumulative total to the full amount closes the order", async () => {
    m.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 7500 } } as never);
    create.mockResolvedValue({ id: "re_2", amount: 2500, status: "succeeded" } as never);

    await executeOrderRefund("ord-1", "admin-1", 2500, "Final part of the refund");

    expect(m.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "REFUNDED" } }));
  });

  it("rejects a refund larger than what is still refundable", async () => {
    m.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 7500 } } as never);
    await expect(executeOrderRefund("ord-1", "admin-1", 3000, "Too much refund")).rejects.toMatchObject({ statusCode: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects when the order is already fully refunded", async () => {
    m.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 10000 } } as never);
    await expect(executeOrderRefund("ord-1", "admin-1", undefined, "Another refund attempt")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a no-amount refund defaults to the remaining amount, not the full total", async () => {
    m.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 4000 } } as never);
    create.mockResolvedValue({ id: "re_3", amount: 6000, status: "pending" } as never);
    await executeOrderRefund("ord-1", "admin-1", undefined, "Refund the rest of the order");
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({ amount: 6000 }));
    // pending at Stripe => PROCESSING, not COMPLETED
    expect(m.refund.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSING" }) }));
  });

  it("a replayed request (same idempotency key) returns the existing refund without calling Stripe", async () => {
    m.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 0 } } as never);
    m.refund.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    m.refund.findUnique.mockResolvedValue({ id: "rr-0", providerRefundId: "re_0", amountMinor: 2500, currency: "eur", status: "COMPLETED" } as never);

    const result = await executeOrderRefund("ord-1", "admin-1", 2500, "Customer double clicked refund", "REFUNDED", false, undefined, "key-1");

    expect(create).not.toHaveBeenCalled();
    expect(result.refundId).toBe("re_0");
  });

  it("marks the Refund row FAILED when Stripe rejects the call", async () => {
    m.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 0 } } as never);
    create.mockRejectedValue(new Error("card_declined"));
    await expect(executeOrderRefund("ord-1", "admin-1", 1000, "Refund that will fail")).rejects.toMatchObject({ statusCode: 502 });
    expect(m.refund.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });
});
