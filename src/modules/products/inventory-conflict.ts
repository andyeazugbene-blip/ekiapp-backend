import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

type InventoryDb = Prisma.TransactionClient | typeof prisma;
const OUTSTANDING_STATUSES = ["PENDING", "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "PAYMENT_SECURED", "VENDOR_CONFIRMED", "DISPUTED"] as const;

/** Checkout has already deducted these order quantities from Product.stock. */
export async function getOutstandingOrderQuantity(db: InventoryDb, productId: string): Promise<number> {
  const aggregate = await db.orderItem.aggregate({
    where: { productId, order: { status: { in: [...OUTSTANDING_STATUSES] }, deliveredAt: null } },
    _sum: { quantity: true },
  });
  return aggregate._sum.quantity ?? 0;
}

/** Recompute a stocktake's current shortfall, consuming fulfilled units after its timestamp. */
export async function getCurrentInventoryConflict(db: InventoryDb, countId: string) {
  const count = await db.productInventoryCount.findUnique({ where: { id: countId } });
  if (!count) return null;
  const [outstanding, fulfilled] = await Promise.all([
    getOutstandingOrderQuantity(db, count.productId),
    db.orderItem.aggregate({
      where: { productId: count.productId, order: { deliveredAt: { gt: count.createdAt } } },
      _sum: { quantity: true },
    }),
  ]);
  const physicalRemaining = Math.max(0, count.physicalQuantity - (fulfilled._sum.quantity ?? 0));
  return { count, outstanding, shortfall: Math.max(0, outstanding - physicalRemaining) };
}
