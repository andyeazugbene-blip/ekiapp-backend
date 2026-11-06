/** The existing organiser decision window for AUTHORISE_THEN_CAPTURE campaigns. */
export const COMMUNITY_BUY_ORGANISER_DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Two-stage payment schedule. Phase 1 promises a hold shortly before the deadline.
 * Scheduled jobs run once a day, so the lead has to span at least one full run,
 * and the decision waits a day after joining closes so late holds can resolve.
 * A card authorisation lasts about seven days, which this comfortably fits inside.
 */
export function defaultAuthorisationSchedule(deadline: Date, holdHoursBefore = 48, decisionHoursAfter = 24): { holdWindowStartsAt: Date; decisionDeadline: Date } {
  return {
    holdWindowStartsAt: new Date(deadline.getTime() - holdHoursBefore * 3_600_000),
    decisionDeadline: new Date(deadline.getTime() + decisionHoursAfter * 3_600_000),
  };
}
