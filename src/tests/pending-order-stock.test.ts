import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { failPendingOrderAndReleaseStock } from "../modules/orders/pending-order-stock.service";

const tx = {
  order: { updateMany: vi.fn() },
  payment: { updateMany: vi.fn() },
  product: { update: vi.fn() },
} as unknown as Prisma.TransactionClient;

const mockTx = tx as unknown as {
  order: { updateMany: ReturnType<typeof vi.fn> };
  payment: { updateMany: ReturnType<typeof vi.fn> };
  product: { update: ReturnType<typeof vi.fn> };
};

describe("failPendingOrderAndReleaseStock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not restore stock when another worker already claimed the order", async () => {
    mockTx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(failPendingOrderAndReleaseStock(tx, {
      orderId: "order-1",
      paymentId: "payment-1",
      items: [{ productId: "product-1", quantity: 3 }],
    })).resolves.toBe(false);

    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.product.update).not.toHaveBeenCalled();
  });

  it("aborts before stock release if the payment is no longer pending", async () => {
    mockTx.order.updateMany.mockResolvedValue({ count: 1 });
    mockTx.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(failPendingOrderAndReleaseStock(tx, {
      orderId: "order-1",
      paymentId: "payment-1",
      items: [{ productId: "product-1", quantity: 3 }],
    })).rejects.toThrow("Pending payment was already finalized");

    expect(mockTx.product.update).not.toHaveBeenCalled();
  });

  it("marks the unpaid order and payment failed before restoring each item once", async () => {
    mockTx.order.updateMany.mockResolvedValue({ count: 1 });
    mockTx.payment.updateMany.mockResolvedValue({ count: 1 });

    await expect(failPendingOrderAndReleaseStock(tx, {
      orderId: "order-1",
      paymentId: "payment-1",
      items: [
        { productId: "product-1", quantity: 3 },
        { productId: "product-2", quantity: 1 },
      ],
    })).resolves.toBe(true);

    expect(mockTx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(mockTx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "payment-1", status: "PENDING" },
      data: expect.objectContaining({ status: "FAILED", processedAt: expect.any(Date) }),
    }));
    expect(mockTx.product.update).toHaveBeenCalledTimes(2);
    expect(mockTx.product.update).toHaveBeenNthCalledWith(1, {
      where: { id: "product-1" },
      data: { stock: { increment: 3 }, stockVersion: { increment: 1 } },
    });
  });
});
