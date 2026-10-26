import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { dispatchNotificationsAfterCommit } from "../events/dispatch-notifications";
import { EVENT_NAMES, eventsService } from "../events/events.service";
import { getOutstandingOrderQuantity } from "./inventory-conflict";

export const inventoryCountsService = {
  async record(userId: string, productId: string, physicalQuantity: number) {
    if (!Number.isSafeInteger(physicalQuantity) || physicalQuantity < 0) throw new AppError("Invalid physicalQuantity", 400);
    const product = await prisma.product.findUnique({
      where: { id: productId }, include: { vendor: { select: { id: true, userId: true, isSuspended: true } } },
    });
    if (!product || product.vendor.userId !== userId || product.vendor.isSuspended) throw new AppError("Product not found", 404);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.product.findUnique({ where: { id: productId }, select: { stock: true, stockVersion: true, vendorId: true } });
      if (!current || current.vendorId !== product.vendorId) throw new AppError("Product not found", 404);
      const outstandingOrderQuantity = await getOutstandingOrderQuantity(tx, productId);
      const shortfallQuantity = Math.max(0, outstandingOrderQuantity - physicalQuantity);
      // Reconcile sellable stock from the physical count after accounting for
      // orders already reserved by checkout. CAS prevents racing a checkout or
      // another stock edit from silently overwriting its quantity.
      const availableQuantity = Math.max(0, physicalQuantity - outstandingOrderQuantity);
      const changed = await tx.product.updateMany({
        where: { id: productId, stock: current.stock, stockVersion: current.stockVersion },
        data: { stock: availableQuantity, stockVersion: { increment: 1 } },
      });
      if (!changed.count) throw new AppError("Stock changed while recording the count; refresh and retry", 409);
      const updated = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { stockVersion: true } });
      const count = await tx.productInventoryCount.create({ data: {
        productId, physicalQuantity, outstandingOrderQuantity, shortfallQuantity, stockVersion: updated.stockVersion,
      } });
      if (shortfallQuantity > 0) {
        await eventsService.enqueueTransactional(tx, {
          name: EVENT_NAMES.product_inventory_conflict_detected,
          actorType: "vendor", actorId: userId, entityType: "Product", entityId: productId,
          source: "vendor_physical_stocktake", consentContext: { purpose: "inventory_transactional", marketing: false },
          payload: { productId, inventoryCountId: count.id, stockVersion: updated.stockVersion },
        }, { dedupeKey: `product-inventory-conflict:${count.id}`, schemaVersion: 1 });
      }
      return { count, availableQuantity };
    });
    if (result.count.shortfallQuantity > 0) await dispatchNotificationsAfterCommit();
    return result;
  },
};
