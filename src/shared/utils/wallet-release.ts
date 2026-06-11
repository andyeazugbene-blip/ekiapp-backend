import { PaymentStatus, WalletTransactionType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../errors/app-error";

/**
 * Atomically release vendor earnings from pendingBalance to availableBalance.
 * Idempotent: safe to call multiple times for the same order.
 *
 * Preconditions checked:
 * - order must exist
 * - order must have a SUCCEEDED payment
 * - order must belong to a single vendor
 * - wallet must have sufficient pendingBalance
 *
 * The order status is NOT changed here — callers update status separately.
 */
export async function releaseVendorEarnings(orderId: string): Promise<{ released: boolean; amount: number }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        payment: { select: { id: true, status: true, vendorEarningsAmount: true, currency: true } },
        items: { select: { vendorId: true } },
      },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (!order.payment || order.payment.status !== PaymentStatus.SUCCEEDED) {
      throw new AppError("Order payment has not succeeded", 400);
    }

    const vendorIds = [...new Set(order.items.map((item) => item.vendorId))];
    if (vendorIds.length !== 1) throw new AppError("Order must have a single vendor", 400);
    const vendorId = vendorIds[0];

    const wallet = await tx.wallet.findUnique({ where: { vendorId } });
    if (!wallet) throw new AppError("Vendor wallet not found", 404);

    const releaseAmount = order.payment.vendorEarningsAmount;

    // Conditional wallet update (prevents negative pendingBalance)
    const walletUpdate = await tx.wallet.updateMany({
      where: { id: wallet.id, pendingBalance: { gte: releaseAmount } },
      data: {
        pendingBalance: { decrement: releaseAmount },
        availableBalance: { increment: releaseAmount },
      },
    });

    if (walletUpdate.count === 0) {
      // Already released or insufficient balance — idempotent success
      const alreadyReleased = await tx.walletTransaction.findFirst({
        where: { orderId, vendorId, type: WalletTransactionType.PENDING_TO_AVAILABLE },
      });
      if (alreadyReleased) {
        return { released: true, amount: releaseAmount };
      }
      throw new AppError("Insufficient pending balance for release", 409);
    }

    // Ledger entry (unique constraint on [vendorId, orderId, paymentId, type] prevents duplicates)
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        vendorId,
        orderId: order.id,
        paymentId: order.payment.id,
        type: WalletTransactionType.PENDING_TO_AVAILABLE,
        amount: releaseAmount,
        currency: order.payment.currency,
        description: `Release pending earnings for order ${order.id}`,
      },
    });

    return { released: true, amount: releaseAmount };
  }, { isolationLevel: "Serializable" });
}
