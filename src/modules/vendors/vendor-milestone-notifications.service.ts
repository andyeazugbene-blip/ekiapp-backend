/**
 * Eki Notification & Automation Engine handoff (12 Oct 2026), vendor
 * activation one-time milestones. Each `maybeSend*`/`send*` function here
 * is a real, idempotent DB check (not a time window) for whether the
 * triggering condition has actually been met, not just "did this code
 * path run" — and relies on communicationService.send()'s dedupeKey (a
 * real unique DB constraint on Notification.dedupeKey) as the second,
 * race-proof layer.
 *
 * Handoff V-06 "store.link.not.shared" used to live here too
 * (runShareReminderSweep) — migrated 2026-10-25 to
 * automation.detectors.ts's detectStoreShareReminder() as
 * STORE_SHARE_REMINDER (spec R10), same precedent this codebase already
 * set removing LOW_STOCK_ALERT's duplicate raw-email path: a raw,
 * non-dedup'd, non-toggleable, non-admin-visible send has no reason to
 * keep existing alongside the real, vendor-toggleable, admin-visible
 * AutomationRule/AutomationRun version once that exists.
 */
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";

export const vendorMilestoneNotificationsService = {
  /** Handoff V-01 "account.created". Fires once, right after a vendor account/store is created. */
  async sendWelcome(vendorId: string): Promise<void> {
    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true, storeName: true, contactEmail: true } });
      if (!vendor) return;
      await communicationService.send({
        eventKey: "vendor_welcome",
        recipientId: vendor.userId,
        recipientEmail: vendor.contactEmail ?? undefined,
        variables: { store_name: vendor.storeName ?? "there" },
        dedupeKey: `VENDOR_WELCOME:${vendorId}`,
      });
    } catch (error) {
      logger.warn("Vendor welcome notification failed (non-blocking)", { vendorId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  },

  /** Handoff V-05 "store.ready". Fires once, the first moment a vendor has both an active product and a delivery zone. */
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
      logger.warn("Store-ready notification failed (non-blocking)", { vendorId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  },

  /**
   * Handoff V-07 "store.link.first.visit". Call BEFORE emitting this
   * view's own store_viewed event (events.service.ts's emit() is
   * fire-and-forget and does not await its own DB write, so counting
   * after emitting would race the write and could read 0 forever) --
   * priorViews===0 means the view about to be recorded is the first ever.
   */
  async maybeSendFirstVisit(vendorId: string, priorViewCount: number): Promise<void> {
    try {
      if (priorViewCount !== 0) return;

      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
      if (!vendor) return;

      await communicationService.send({
        eventKey: "vendor_store_first_visit",
        recipientId: vendor.userId,
        variables: {},
        dedupeKey: `STORE_FIRST_VISIT:${vendorId}`,
      });
    } catch (error) {
      logger.warn("First-visit notification failed (non-blocking)", { vendorId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  },

};
