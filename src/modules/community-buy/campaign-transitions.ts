import type { CampaignStatus } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";

/**
 * Handbook 10.2 - the single source of truth for Community Buy campaign
 * state transitions. Every service path that moves a campaign between
 * statuses calls assertCampaignTransition() before its (still atomic,
 * status-scoped) database claim, so an illegal jump can never be introduced
 * by one call site drifting from the others.
 *
 * Mapping from the handbook's names to the stored enum:
 *  - "Draft"/"Pending approval"/"Live"/"Completed" -> DRAFT/UNDER_REVIEW/LIVE/COMPLETED
 *  - "Target reached" -> a campaign that met its minimum or goal records
 *    fundingOutcome GOAL_REACHED/MINIMUM_REACHED and moves straight on to
 *    FULFILLING in one atomic step (SUCCEEDED remains a legal intermediate
 *    for paths that need to hold at "target reached").
 *  - "Closed unsuccessful" -> FAILED, "Refund processing" -> REFUNDING.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "CHANGES_REQUIRED", "CANCELLED"],
  CHANGES_REQUIRED: ["UNDER_REVIEW", "CANCELLED"],
  APPROVED: ["LIVE", "CHANGES_REQUIRED", "CANCELLED"],
  REJECTED: [],
  LIVE: ["PAUSED", "CHANGES_REQUIRED", "RESCUE_WINDOW", "SUCCEEDED", "FULFILLING", "HOLD_WINDOW", "CANCELLED", "CANCELLATION_UNDER_REVIEW", "CLOSING"],
  PAUSED: ["LIVE", "CANCELLED", "CANCELLATION_UNDER_REVIEW"],
  CLOSING: ["SUCCEEDED", "RESCUE_WINDOW", "FAILED", "FULFILLING"],
  RESCUE_WINDOW: ["LIVE", "FULFILLING", "FAILED", "CANCELLED", "CANCELLATION_UNDER_REVIEW"],
  SUCCEEDED: ["FULFILLING", "CANCELLED", "CANCELLATION_UNDER_REVIEW"],
  FAILED: ["REFUNDING", "FINANCIALLY_CLOSED"],
  REFUNDING: ["FINANCIALLY_CLOSED"],
  FULFILLING: ["COMPLETED", "CANCELLATION_UNDER_REVIEW"],
  COMPLETED: ["FINANCIALLY_CLOSED"],
  FINANCIALLY_CLOSED: [],
  CANCELLED: [],
  CANCELLATION_UNDER_REVIEW: ["CANCELLED", "LIVE", "PAUSED", "RESCUE_WINDOW", "FULFILLING", "SUCCEEDED"],
  // AUTHORISE_THEN_CAPTURE-only states
  HOLD_WINDOW: ["DECISION_REQUIRED", "PAYMENT_CAPTURE", "FAILED", "CANCELLED"],
  DECISION_REQUIRED: ["AWAITING_SUPPLIER_RECONFIRMATION", "PAYMENT_CAPTURE", "FAILED", "CANCELLED"],
  AWAITING_SUPPLIER_RECONFIRMATION: ["PAYMENT_CAPTURE", "FAILED", "CANCELLED"],
  PAYMENT_CAPTURE: ["FULFILLING", "FAILED", "CANCELLED"],
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Every status from which `to` is a legal next state - usable directly as a `status: { in: ... }` claim filter. */
export function campaignSourcesFor(to: CampaignStatus): CampaignStatus[] {
  return (Object.keys(CAMPAIGN_TRANSITIONS) as CampaignStatus[]).filter((from) => CAMPAIGN_TRANSITIONS[from].includes(to));
}

export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus, message?: string): void {
  if (!canTransitionCampaign(from, to)) {
    throw new AppError(message ?? `A campaign in ${from} cannot move to ${to}.`, 409, { from, to }, "CAMPAIGN_TRANSITION_INVALID");
  }
}
