/**
 * Eki Notification & Automation Engine handoff (12 Oct 2026), vendor
 * activation one-time milestones and the "share not detected" reminder.
 * Each `maybeSend*`/`send*` function here is a real, idempotent DB check
 * (not a time window) for whether the triggering condition has actually
 * been met, not just "did this code path run" — and relies on
 * communicationService.send()'s dedupeKey (a real unique DB constraint on
 * Notification.dedupeKey) as the second, race-proof layer.
 */
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";

const DAY_MS = 24 * 60 * 60 * 1000;
/** V-06's recommended default cadence (handoff: "24h; day 3; day 7") — a configurable default, not a locked value; see NOTIFICATION_ENGINE_GAP_ANALYSIS_AND_PLAN.md. */
const SHARE_REMINDER_COOLDOWN_DAYS = 3;

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

  /**
   * Handoff V-06 "store.link.not.shared" — a repeating reminder (default
   * cooldown SHARE_REMINDER_COOLDOWN_DAYS, configurable), stopping once a
   * store_viewed event has ever been recorded. Intended to be called from
   * a daily sweep job, once per ready-but-unvisited vendor.
   */
  async runShareReminderSweep(): Promise<number> {
    const candidates = await prisma.vendor.findMany({
      where: { isSuspended: false, products: { some: { isActive: true } } },
      select: { id: true, userId: true, storeName: true },
      take: 500,
    });
    if (candidates.length === 0) return 0;

    // DeliveryZone has no back-relation declared on Vendor (plain vendorId
    // FK only, same as everywhere else in this codebase that queries it) —
    // one grouped query for the whole batch rather than N+1 per-vendor lookups.
    const zoneCounts = await prisma.deliveryZone.groupBy({ by: ["vendorId"], where: { vendorId: { in: candidates.map((v) => v.id) } }, _count: { _all: true } });
    const hasZone = new Set(zoneCounts.filter((z) => z._count._all > 0).map((z) => z.vendorId));
    const readyVendors = candidates.filter((v) => hasZone.has(v.id));

    let sent = 0;
    for (const vendor of readyVendors) {
      const everVisited = await prisma.event.count({ where: { name: "store_viewed", entityType: "Vendor", entityId: vendor.id } });
      if (everVisited > 0) continue;

      const cooldownBucket = Math.floor(Date.now() / (SHARE_REMINDER_COOLDOWN_DAYS * DAY_MS));
      try {
        const result = await communicationService.send({
          eventKey: "vendor_store_not_shared",
          recipientId: vendor.userId,
          variables: { store_name: vendor.storeName ?? "Your store" },
          dedupeKey: `STORE_NOT_SHARED:${vendor.id}:${cooldownBucket}`,
        });
        if (result.outcome === "SENT") sent++;
      } catch (error) {
        logger.warn("Share-reminder send failed", { vendorId: vendor.id, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }
    return sent;
  },
};
