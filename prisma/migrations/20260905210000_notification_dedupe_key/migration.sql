-- Idempotent notification creation, reusing the same convention already
-- established by AutomationRun.dedupeKey and WebhookEvent.stripeEventId:
-- a nullable, unique business-identity key enforced at the DB level.
--
-- Root cause fixed: sendUpcomingRenewalReminders() deduped the
-- AutomationRun it schedules (via AutomationRun.dedupeKey) but called
-- notificationsService.enqueue() for the in-app "Upcoming Regular
-- Delivery" notification completely unconditionally beforehand — repeated
-- sweeps (retries, overlapping cron triggers, concurrent invocations)
-- created a fresh duplicate Notification row every time, even though the
-- automation itself correctly fired at most once.

ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
