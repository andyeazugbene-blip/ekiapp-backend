import { describe, expect, it } from "vitest";

import { orderAcceptanceNotificationsService } from "../modules/orders/order-acceptance-notifications.service";

describe("order reminder sweeps fail closed without authoritative timing inputs", () => {
  it("skips R13 acceptance reminders until a business-hours SLA is approved", async () => {
    await expect(orderAcceptanceNotificationsService.runUnacknowledgedOrderSweep()).resolves.toEqual({
      firstReminders: 0,
      escalations: 0,
      skipped: true,
      reason: "business_hours_sla_required",
    });
  });

  it("skips R15 dispatch reminders until an actual dispatch deadline exists", async () => {
    await expect(orderAcceptanceNotificationsService.runDispatchDueSweep()).resolves.toEqual({
      reminders: 0,
      breaches: 0,
      skipped: true,
      reason: "dispatch_deadline_required",
    });
  });
});
