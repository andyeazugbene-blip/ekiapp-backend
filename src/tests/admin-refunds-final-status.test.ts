/**
 * Acceptance audit fix (Defect C) — executeOrderRefund() gained an optional
 * finalStatus param so a vendor-cancelled order can land on CANCELLED
 * instead of REFUNDED (the admin-initiated default, unchanged). Its
 * already-refunded guard was also broadened from checking only
 * status === "REFUNDED" to also checking "CANCELLED", closing a real
 * double-refund hole: before this fix, an admin could refund an order a
 * vendor had already cancelled-and-refunded a second time, since CANCELLED
 * wasn't recognized as "already handled."
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findUnique: vi.fn(), update: vi.fn() },
    paystackTransaction: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { refunds: { create: vi.fn() } },
}));

vi.mock("../lib/paystack", () => ({
  paystack: { refundTransaction: vi.fn(), isConfigured: vi.fn(() => true) },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { executeOrderRefund } from "../modules/admin/admin-refunds.controller";

const m = vi.mocked(prisma, true) as any;
const stripeRefundCreate = vi.mocked(stripe.refunds.create);

beforeEach(() => {
  vi.clearAllMocks();
  m.$transaction.mockImplementation(async (cb: any) => cb(m));
});

function paidOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    status: "PAID",
    totalAmount: 1000,
    currency: "gbp",
    checkoutCurrency: null,
    exchangeRate: null,
    payment: { id: "pay-1", stripePaymentIntentId: "pi_1", status: "SUCCEEDED", amount: 1000, provider: "stripe" },
    paystackTransaction: null,
    ...overrides,
  };
}

describe("executeOrderRefund — finalStatus param", () => {
  it("defaults to REFUNDED when no finalStatus is passed (admin path, unchanged)", async () => {
    m.order.findUnique.mockResolvedValue(paidOrder());
    stripeRefundCreate.mockResolvedValue({ id: "re_1", amount: 1000, status: "succeeded" } as never);

    await executeOrderRefund("order-1", "admin-1", undefined, "requested_by_customer");

    expect(m.order.update).toHaveBeenCalledWith({ where: { id: "order-1" }, data: { status: "REFUNDED" } });
  });

  it("sets status to CANCELLED when finalStatus='CANCELLED' is passed (vendor-cancel path)", async () => {
    m.order.findUnique.mockResolvedValue(paidOrder());
    stripeRefundCreate.mockResolvedValue({ id: "re_2", amount: 1000, status: "succeeded" } as never);

    await executeOrderRefund("order-1", "vendor-user-1", undefined, "vendor_cancelled_paid_order", "CANCELLED");

    expect(m.order.update).toHaveBeenCalledWith({ where: { id: "order-1" }, data: { status: "CANCELLED" } });
  });
});

describe("executeOrderRefund — double-refund guard now also blocks an already-CANCELLED order", () => {
  it("throws 409 and never calls Stripe when the order is already CANCELLED", async () => {
    m.order.findUnique.mockResolvedValue(paidOrder({ status: "CANCELLED" }));

    await expect(executeOrderRefund("order-1", "admin-1", undefined, "requested_by_customer"))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it("Phase 4.1: throws 409 and never calls Stripe when the order has an open Stripe dispute", async () => {
    m.order.findUnique.mockResolvedValue(paidOrder({ status: "DISPUTED" }));

    await expect(executeOrderRefund("order-1", "admin-1", undefined, "requested_by_customer"))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it("still throws 409 for an already-REFUNDED order (regression check)", async () => {
    m.order.findUnique.mockResolvedValue(paidOrder({ status: "REFUNDED" }));

    await expect(executeOrderRefund("order-1", "admin-1", undefined, "requested_by_customer"))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });
});
