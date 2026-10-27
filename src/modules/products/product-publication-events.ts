import type { Event, Prisma, Product } from "@prisma/client";

import { eventsService, EVENT_NAMES } from "../events/events.service";

/** Persist the publication fact in the same transaction that makes the listing visible. */
export async function enqueueProductPublished(
  tx: Prisma.TransactionClient,
  product: Pick<Product, "id" | "vendorId" | "publishedAt">,
  actor: { actorType: "vendor" | "system" | "admin"; actorId?: string; source: string },
): Promise<Event | null> {
  if (!product.publishedAt) return null;
  return eventsService.enqueueTransactional(tx, {
    name: EVENT_NAMES.product_published,
    actorType: actor.actorType,
    actorId: actor.actorId,
    entityType: "Product",
    entityId: product.id,
    source: actor.source,
    secondaryEntities: { vendorId: product.vendorId },
    payload: { productId: product.id, vendorId: product.vendorId, publishedAt: product.publishedAt.toISOString() },
  }, { dedupeKey: `product-published:${product.id}`, schemaVersion: 1 });
}
