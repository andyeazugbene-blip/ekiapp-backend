/**
 * Handoff CB-18 "capture.pending_review" (Eki Notification & Automation
 * Engine, 12 Oct 2026): "On delayed/uncertain capture; Provider outcome
 * pending -> Resolved. 'Payment under review. Do not pay again.'"
 *
 * `CommunityBuyPaymentAuthorisation.captureStatus` is claimed to
 * CAPTURE_PENDING immediately before calling Stripe's capture API
 * (campaign-authorisation.service.ts `attemptCapture`) and is supposed to
 * resolve to CAPTURED or CAPTURE_FAILED synchronously, within the same
 * function call, milliseconds later. A row a SEPARATE sweep finds still
 * sitting in CAPTURE_PENDING therefore already means that synchronous
 * flow was interrupted (a serverless function timeout/crash mid-capture,
 * a network partition to Stripe) -- it does not need to have been stuck
 * for any particular duration to be worth surfacing; normal captures
 * never appear in an independent query at all, since they've already
 * moved to CAPTURED/CAPTURE_FAILED by the time anything else could read
 * them.
 *
 * Deliberately READ-ONLY with respect to money: this sends the required
 * buyer notification and an ops alert, and does NOT retry, capture,
 * release, or otherwise touch the authorisation or any Stripe object --
 * resolving an ambiguous Stripe capture safely needs a real requery
 * against Stripe's own state (the same pattern renewals.service.ts's
 * requeryAmbiguousAttempt() uses for Regular Delivery), which is a
 * separate, carefully-scoped change to the capture code itself, not
 * bundled into a notification feature.
 */
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { notificationsService } from "../notifications/notifications.service";
import { alertOps } from "./ops-alert.service";

export const capturePendingReviewService = {
  async runSweep(): Promise<{ notified: number }> {
    const stuck = await prisma.communityBuyPaymentAuthorisation.findMany({
      where: { captureStatus: "CAPTURE_PENDING" },
      select: {
        id: true,
        campaignId: true,
        contribution: { select: { participant: { select: { userId: true } } } },
      },
      take: 200,
    });
    if (stuck.length === 0) return { notified: 0 };

    let notified = 0;
    for (const authorisation of stuck) {
      const userId = authorisation.contribution.participant.userId;
      try {
        await notificationsService.enqueue({
          userId,
          type: "COMMUNITY_CAMPAIGN_UPDATE",
          title: "Payment under review",
          body: "Payment under review. Do not pay again.",
          data: { type: "community_campaign_update", event: "capture_pending_review", campaignId: authorisation.campaignId },
          // Day-bucketed: re-notifies once per day for as long as it stays
          // stuck, rather than either spamming every sweep run or going
          // silent after the first one while still unresolved.
          dedupeKey: `CAPTURE_PENDING_REVIEW:${authorisation.id}:${new Date().toISOString().slice(0, 10)}`,
        });
        notified++;
      } catch (error) {
        logger.warn("Capture-pending-review notification failed", { authorisationId: authorisation.id, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }

    await alertOps(
      `⚠️ ${stuck.length} Community Buy capture(s) stuck in CAPTURE_PENDING`,
      `<p>These need manual review against Stripe's own state — this sweep only notifies affected buyers, it never retries or resolves the capture itself.</p><ul>${stuck.map((a) => `<li>Authorisation ${a.id} (campaign ${a.campaignId})</li>`).join("")}</ul>`,
    ).catch((error) => logger.warn("Capture-pending-review ops alert failed", { errorMessage: error instanceof Error ? error.message : String(error) }));

    return { notified };
  },
};
