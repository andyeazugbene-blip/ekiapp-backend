import { eventsService, EVENT_NAMES } from "../events/events.service";

/**
 * Canonical Community Buy lifecycle events (handbook 12 / 10.2).
 *
 * Emitted only AFTER the atomic status claim succeeded (claim.count === 1), so a
 * racing sweep or double click cannot emit twice for the same transition.
 * Delivery is still at-least-once, so every payload carries a stable
 * `eventKey` that consumers can dedupe on.
 *
 * Fire-and-forget and never throws: safe to call on any path.
 */
type CampaignLifecycleName =
  | typeof EVENT_NAMES.community_buy_target_reached
  | typeof EVENT_NAMES.community_buy_target_failed
  | typeof EVENT_NAMES.community_buy_refund_started
  | typeof EVENT_NAMES.community_buy_fulfilled
  | typeof EVENT_NAMES.community_buy_completed;

export function emitCampaignLifecycleEvent(
  name: CampaignLifecycleName,
  campaignId: string,
  source: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    eventsService.emit({
      name,
      actorType: "system",
      entityType: "CommunityCampaign",
      entityId: campaignId,
      source,
      payload: { campaignId, eventKey: `${name}:${campaignId}`, ...extra },
    });
  } catch {
    // never let telemetry affect the transition that triggered it
  }
}
