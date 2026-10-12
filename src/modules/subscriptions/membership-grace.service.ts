/**
 * Eki Notification & Automation Engine handoff (12 Oct 2026):
 *  - M-05 "membership.grace.started" is sent inline from
 *    stripe.service.ts's invoice.payment_failed handler (merged with M-04,
 *    see that handler's own doc comment for why).
 *  - M-06 "membership.capabilities.paused": "After configured grace expiry
 *    ... Pause criteria met -> Restored. 'Your store capabilities are
 *    paused. Your store data is safe.'"
 *
 * The grace length is read live from the admin-configurable
 * MEMBERSHIP_GRACE_PERIOD_DAYS setting (admin-platform-settings.service.ts)
 * — per the owner's explicit instruction ("let admin panel configured make
 * it flexible") rather than a hardcoded number.
 *
 * Deliberately NOTIFICATION-ONLY. "Which capabilities actually pause" is
 * itself unresolved per the handoff's own §13 ("paused capabilities" is
 * listed as a still-open owner sign-off alongside grace length) — this
 * sends the required message and marks the episode, but does NOT wire any
 * enforcement (e.g. blocking new orders) into the checkout path. Doing
 * that safely needs its own explicit confirmation of what "paused" means
 * in practice, separate from the timing question this file answers; see
 * docs/NOTIFICATION_ENGINE_GAP_ANALYSIS_AND_PLAN.md.
 */
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";
import { adminPlatformSettingsService } from "../admin/admin-platform-settings.service";

const DAY_MS = 24 * 60 * 60 * 1000;

export const membershipGraceService = {
  /** M-06: pauses-notification for a PAST_DUE subscription whose grace period (admin-configured) has elapsed since it went PAST_DUE. */
  async runCapabilitiesPausedSweep(): Promise<{ notified: number }> {
    const graceDays = await adminPlatformSettingsService.getValue("MEMBERSHIP_GRACE_PERIOD_DAYS");
    if (graceDays == null) return { notified: 0 }; // not yet configured — never guess a value.

    const cutoff = new Date(Date.now() - graceDays * DAY_MS);
    // VendorSubscription.updatedAt reflects the moment status last changed
    // (Prisma auto-updates it on the PAST_DUE write) -- no separate
    // "graceStartedAt" column needed to know how long this episode has run.
    const subscriptions = await prisma.vendorSubscription.findMany({
      where: { status: "PAST_DUE", updatedAt: { lt: cutoff } },
      select: { id: true, vendorId: true, updatedAt: true },
      take: 500,
    });
    if (subscriptions.length === 0) return { notified: 0 };

    const vendors = await prisma.vendor.findMany({
      where: { id: { in: subscriptions.map((s) => s.vendorId) } },
      select: { id: true, userId: true, storeName: true, contactEmail: true },
    });
    const vendorsById = new Map(vendors.map((v) => [v.id, v]));

    let notified = 0;
    for (const sub of subscriptions) {
      const vendor = vendorsById.get(sub.vendorId);
      if (!vendor) continue;
      try {
        const result = await communicationService.send({
          eventKey: "vendor_membership_capabilities_paused",
          recipientId: vendor.userId,
          recipientEmail: vendor.contactEmail ?? undefined,
          variables: { store_name: vendor.storeName ?? "Your store" },
          // Scoped to this specific PAST_DUE episode via updatedAt -- a
          // later recovery-then-fail-again cycle gets its own dedupe scope
          // rather than being silently suppressed forever.
          dedupeKey: `MEMBERSHIP_PAUSED:${sub.id}:${sub.updatedAt.toISOString()}`,
        });
        if (result.outcome === "SENT") notified++;
      } catch (error) {
        logger.warn("Membership capabilities-paused notification failed", { subscriptionId: sub.id, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }
    return { notified };
  },
};
