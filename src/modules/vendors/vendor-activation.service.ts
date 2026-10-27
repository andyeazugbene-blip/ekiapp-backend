import { vendorMilestoneNotificationsService } from "./vendor-milestone-notifications.service";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { recordAudit } from "../../shared/utils/audit";
import { communicationService } from "../communications/communication.service";
import { enqueueProductPublished } from "../products/product-publication-events";
import { dispatchNotificationsAfterCommit } from "../events/dispatch-notifications";

/**
 * Vendor-activation spec (12 Oct 2026): "Once verification succeeds, the
 * system must automatically ... publish eligible pending listings without
 * additional vendor action ... notify the vendor only after publication
 * succeeds." This is that automatic publish step.
 *
 * Store readiness = vendor VERIFIED + at least one active delivery zone
 * (a published product with nowhere to ship is a dead end for the buyer).
 * Called from two places, because either can be the LAST step the vendor
 * completes: stripe-identity.service.ts (verification just succeeded) and
 * delivery-zones.service.ts (first zone just added, vendor may already be
 * verified). Both calls are safe to run redundantly or concurrently:
 * the publishing update is filtered on status=PENDING_ACTIVATION, so once
 * a row is published, a second/concurrent call simply finds nothing left
 * to do for it — no duplicate notification, no duplicate audit entry.
 */
export const vendorActivationService = {
  async publishEligibleProducts(vendorId: string): Promise<{ published: number }> {
    try {
      const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { id: true, userId: true, storeName: true, verificationStatus: true, contactEmail: true, user: { select: { email: true } } },
      });
      if (!vendor || vendor.verificationStatus !== "VERIFIED") {
        return { published: 0 };
      }

      const hasDeliveryZone = (await prisma.deliveryZone.count({ where: { vendorId, isActive: true } })) > 0;
      if (!hasDeliveryZone) {
        // Not a failure — the vendor just hasn't configured delivery yet.
        // Listings stay PENDING_ACTIVATION; this re-runs (and succeeds)
        // the moment createVendorZone() adds their first zone.
        return { published: 0 };
      }

      const eligible = await prisma.product.findMany({
        where: { vendorId, status: "PENDING_ACTIVATION" },
        select: { id: true, title: true, images: true, priceInCents: true },
      });
      if (eligible.length === 0) {
        return { published: 0 };
      }

      const now = new Date();
      const result = await prisma.$transaction(async (tx) => {
        const changed = await tx.product.updateMany({
          where: { vendorId, status: "PENDING_ACTIVATION", id: { in: eligible.map((p) => p.id) } },
          data: { status: "PUBLISHED", isActive: true, publishedAt: now },
        });
        if (changed.count === 0) return { count: 0, products: [] as Array<{ id: string; vendorId: string; publishedAt: Date | null }> };
        const products = await tx.product.findMany({
          where: { vendorId, id: { in: eligible.map((p) => p.id) }, status: "PUBLISHED", publishedAt: now },
          select: { id: true, vendorId: true, publishedAt: true },
        });
        for (const product of products) {
          await enqueueProductPublished(tx, product, { actorType: "system", source: "vendor_activation_auto_publish" });
        }
        return { count: changed.count, products };
      });
      if (result.count === 0) {
        // Lost the race to a concurrent call (e.g. the delivery-zone and
        // verification triggers both firing close together) — nothing left to do.
        return { published: 0 };
      }

      void dispatchNotificationsAfterCommit();
      if (process.env.R09_PUBLICATION_CONFIRMED_ENABLED !== "true") {
        void vendorMilestoneNotificationsService.maybeSendStoreReady(vendorId);
      }

      await recordAudit({
        actorId: "system:vendor-activation",
        action: "VENDOR_PRODUCTS_AUTO_PUBLISHED",
        entityType: "Vendor",
        entityId: vendorId,
        metadata: { count: result.count, productIds: eligible.map((p) => p.id) },
      });

      // Spec: "The vendor receives confirmation when their store and
      // foodstuff are genuinely live" — sent only here, after the DB write
      // that actually makes them live has committed, never speculatively.
      if (process.env.R09_PUBLICATION_CONFIRMED_ENABLED !== "true") communicationService
        .send({
          eventKey: "vendor_store_and_products_live",
          recipientId: vendor.userId,
          recipientEmail: vendor.contactEmail ?? vendor.user.email,
          variables: { store_name: vendor.storeName, count: String(result.count) },
          dedupeKey: `VENDOR_AUTO_PUBLISH:${vendorId}:${now.toISOString()}`,
        })
        .catch((err) => logger.warn("Vendor auto-publish confirmation failed", { vendorId, error: String(err) }));

      logger.info("Vendor products auto-published on activation", { vendorId, count: result.count });
      return { published: result.count };
    } catch (error) {
      // Spec: "Failed automatic activation must be logged and retried
      // safely." This never throws into the caller (a webhook or a
      // delivery-zone create must still succeed) — the next trigger
      // (another webhook retry, or the vendor/admin adding a zone or
      // reopening the app) re-attempts the same idempotent publish.
      logger.error("Vendor product auto-publish failed", { vendorId, error: String(error) });
      await recordAudit({
        actorId: "system:vendor-activation",
        action: "VENDOR_PRODUCTS_AUTO_PUBLISH_FAILED",
        entityType: "Vendor",
        entityId: vendorId,
        metadata: { error: String(error) },
      }).catch(() => undefined);
      return { published: 0 };
    }
  },
};
