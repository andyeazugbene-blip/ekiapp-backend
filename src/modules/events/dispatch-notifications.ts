import { notificationDeliveryService } from "../notifications/notification-delivery.service";
import { registerCoreEventHandlers } from "./core-event-handlers";
import { eventOutboxService } from "./event-outbox.service";

/** Best-effort post-commit flush; durable scheduled jobs recover anything left pending. */
export async function dispatchNotificationsAfterCommit(): Promise<void> {
  registerCoreEventHandlers();
  try {
    await eventOutboxService.dispatchRegisteredBatch(100);
    await notificationDeliveryService.dispatchBatch(100);
  } catch {
    // Domain writes have already committed. The scheduled durable sweep is the recovery path.
  }
}
