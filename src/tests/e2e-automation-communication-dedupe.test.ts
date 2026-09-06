/**
 * REAL database regression test for the renewal-reminder double-notification
 * bug: renewals.service.ts's sendUpcomingRenewalReminders() creates its own
 * in-app Notification directly (via notificationsService.enqueue, with a
 * dedupeKey), THEN calls automationService.scheduleAutomation() for the same
 * logical event — which, before this fix, called communicationService.send()
 * with no dedupeKey at all, so its in_app channel created a SECOND
 * Notification (type AUTOMATION_MESSAGE) for the exact same real-world event,
 * on every single first-time send, not just on retries. Confirmed against
 * real historical QA data: two Notification rows ("Upcoming Regular
 * Delivery", one SUBSCRIPTION_UPDATE and one AUTOMATION_MESSAGE) created
 * milliseconds apart for one renewal, before this fix.
 *
 * Fixed by threading the same dedupeKey automationService.scheduleAutomation()
 * already builds for its own AutomationRun through to
 * communicationService.send()'s in_app write, so a caller that already used
 * that exact key for its own Notification causes this second write to
 * collide against the real DB unique constraint and get silently skipped —
 * this test proves that collision actually happens, against a real Postgres
 * connection, not a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { notificationsService } from "../modules/notifications/notifications.service";
import { communicationService } from "../modules/communications/communication.service";

const prisma = new PrismaClient();

const TEST_EMAIL = `e2e-automation-dedupe-${Date.now()}@test.eki`;
let buyerId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: TEST_EMAIL, name: "E2E Automation Dedupe Buyer", password: "unused", role: "BUYER" },
  });
  buyerId = user.id;
});

afterAll(async () => {
  await prisma.communicationLog.deleteMany({ where: { recipientId: buyerId } });
  await prisma.notification.deleteMany({ where: { userId: buyerId } });
  await prisma.user.deleteMany({ where: { id: buyerId } });
  await prisma.$disconnect();
});

describe("communicationService.send — dedupeKey threading (real database)", () => {
  it("does NOT create a second Notification when the in_app write shares a dedupeKey already used by a direct enqueue() call", async () => {
    const dedupeKey = `RENEWAL_REMINDER:e2e-sub-1:2026-09-10`;

    // Step 1: what renewals.service.ts does directly, before scheduling the automation.
    const direct = await notificationsService.create({
      userId: buyerId,
      type: "SUBSCRIPTION_UPDATE",
      title: "Upcoming Regular Delivery",
      body: "Your delivery renews soon.",
      dedupeKey,
    });
    expect(direct).not.toBeNull();

    // Step 2: what automationService.scheduleAutomation() now does — passes
    // the SAME dedupeKey through to the in_app channel write.
    await communicationService.send({
      eventKey: "welcome_buyer", // any enabled template with an in_app channel and no push, so this test only exercises the in_app write path
      recipientId: buyerId,
      variables: { name: "Test Buyer" },
      notificationType: "AUTOMATION_MESSAGE",
      dedupeKey,
    });

    const rows = await prisma.notification.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("SUBSCRIPTION_UPDATE"); // the original, not overwritten or duplicated
  });

  it("still creates its own Notification when no other write has used that dedupeKey yet (a genuinely new event isn't suppressed)", async () => {
    const dedupeKey = `RENEWAL_REMINDER:e2e-sub-2:2026-09-10`;

    await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: buyerId,
      variables: { name: "Test Buyer" },
      notificationType: "AUTOMATION_MESSAGE",
      dedupeKey,
    });

    const rows = await prisma.notification.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("AUTOMATION_MESSAGE");
  });

  it("omitting dedupeKey entirely still works (backward compatible — most communicationService.send() callers don't pass one)", async () => {
    await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: buyerId,
      variables: { name: "Test Buyer" },
      notificationType: "ADMIN_BROADCAST",
    });

    const rows = await prisma.notification.findMany({ where: { userId: buyerId, type: "ADMIN_BROADCAST" } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
