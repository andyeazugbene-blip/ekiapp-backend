import type { Prisma, Product } from "@prisma/client";

import { eventsService, EVENT_NAMES } from "../events/events.service";

/** Persist one R17 event only for a successful positive stock decrement to zero. */
export async function enqueueProductStockDepleted(
  tx: Prisma.TransactionClient,
  input: { product: Pick<Product, "id" | "stock" | "stockVersion" | "status" | "isActive">; stockDecrementedBy: number; actorId?: string | null; actorType: string },
): Promise<boolean> {
  const { product } = input;
  // R17 stays off until the semantic mobile route and production timing are approved.
  if (process.env.R17_STOCK_DEPLETED_ENABLED !== "true") return false;
  if (input.stockDecrementedBy <= 0 || product.stock !== 0 || !product.isActive || product.status !== "PUBLISHED") return false;

  const stockEpisode = product.stockVersion;
  await eventsService.enqueueTransactional(tx, {
    name: EVENT_NAMES.product_stock_depleted,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    entityType: "Product",
    entityId: product.id,
    source: "product_stock_transition",
    consentContext: { purpose: "inventory_transactional", marketing: false },
    payload: { productId: product.id, stockVersion: stockEpisode },
  }, { dedupeKey: `product-stock-depleted:${product.id}:v${stockEpisode}`, schemaVersion: 1 });
  return true;
}
