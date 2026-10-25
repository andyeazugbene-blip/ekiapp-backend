import type { Prisma } from "@prisma/client";

export interface PendingOrderStockItem {
  productId: string;
  quantity: number;
}

/**
 * Atomically fail a still-pending unpaid order and release its stock exactly
 * once. The conditional order and payment updates make concurrent cleanup
 * workers/cron runs harmless. Call inside a Prisma transaction so a payment
 * that became final before the claim rolls the order claim back as well.
 */
export async function failPendingOrderAndReleaseStock(
  tx: Prisma.TransactionClient,
  input: { orderId: string; paymentId: string; items: PendingOrderStockItem[] },
): Promise<boolean> {
  const orderClaim = await tx.order.updateMany({
    where: { id: input.orderId, status: "PENDING" },
    data: { status: "FAILED" },
  });
  if (orderClaim.count !== 1) return false;

  const paymentClaim = await tx.payment.updateMany({
    where: { id: input.paymentId, status: "PENDING" },
    data: { status: "FAILED", processedAt: new Date() },
  });
  if (paymentClaim.count !== 1) {
    // Throwing aborts the transaction, including the order claim, so a late
    // provider success cannot be converted into a failed order with restored
    // inventory.
    throw new Error("Pending payment was already finalized; stock release was skipped");
  }

  for (const item of input.items) {
    await tx.product.update({
      where: { id: item.productId },
      data: { stock: { increment: item.quantity } },
    });
  }

  return true;
}
