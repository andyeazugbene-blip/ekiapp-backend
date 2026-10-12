/**
 * Eki Notification & Automation Engine handoff (12 Oct 2026), V-05
 * "store.ready": "Store operational -> Immediate -> Your store is ready.
 * Share it with buyers." Fires exactly once per vendor, the first moment
 * they have BOTH an active product and a delivery zone -- the same two
 * signals the vendor funnel (admin-vendor-funnel.service.ts) and the
 * FIRST_SALE onboarding detector already treat as "setup done," so this
 * can never disagree with what those already report.
 *
 * Called from both trigger points (first product created, first delivery
 * zone created) because either one can complete the pair first; whichever
 * fires second is the one that actually sends. Idempotency is a REAL DB
 * check (does the vendor now have >=1 of each), not a time window, and
 * communicationService.send()'s dedupeKey additionally guarantees at most
 * one Notification/push/email even if both trigger points somehow race.
 */
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";

export const vendorMilestoneNotificationsService = {
  async maybeSendStoreReady(vendorId: string): Promise<void> {
    try {
      const [vendor, productCount, zoneCount] = await Promise.all([
        prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true, storeName: true, contactEmail: true } }),
        prisma.product.count({ where: { vendorId, isActive: true } }),
        prisma.deliveryZone.count({ where: { vendorId } }),
      ]);
      if (!vendor || productCount < 1 || zoneCount < 1) return;

      await communicationService.send({
        eventKey: "vendor_store_ready",
        recipientId: vendor.userId,
        recipientEmail: vendor.contactEmail ?? undefined,
        variables: { store_name: vendor.storeName ?? "Your store" },
        dedupeKey: `STORE_READY:${vendorId}`,
      });
    } catch (error) {
      // Never let a milestone notification break the product/delivery-zone
      // write it's attached to.
      logger.warn("Store-ready notification failed (non-blocking)", {
        vendorId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
