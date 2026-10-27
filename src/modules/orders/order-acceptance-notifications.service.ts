/**
 * The order reminder handoff refers to business-minute/SLA timing for vendor
 * acceptance and a dispatch due time. The current Order schema has no
 * dispatch deadline, and the application has no approved business-hours
 * calendar for acceptance SLAs. Until those authoritative inputs exist,
 * these legacy sweeps fail closed instead of sending from elapsed-time
 * guesses. Order state notifications with confirmed transitions remain
 * handled by their separate event producers.
 */

export const orderAcceptanceNotificationsService = {
  /** R13/O-02 needs an approved business-hours calendar and SLA. */
  async runUnacknowledgedOrderSweep(): Promise<{
    firstReminders: 0;
    escalations: 0;
    skipped: true;
    reason: "business_hours_sla_required";
  }> {
    return {
      firstReminders: 0,
      escalations: 0,
      skipped: true,
      reason: "business_hours_sla_required",
    };
  },

  /** R15/O-04 needs a real dispatch deadline persisted from approved policy. */
  async runDispatchDueSweep(): Promise<{
    reminders: 0;
    breaches: 0;
    skipped: true;
    reason: "dispatch_deadline_required";
  }> {
    return {
      reminders: 0,
      breaches: 0,
      skipped: true,
      reason: "dispatch_deadline_required",
    };
  },
};
