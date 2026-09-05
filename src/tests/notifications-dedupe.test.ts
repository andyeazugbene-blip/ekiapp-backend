/**
 * notificationsService.create/enqueue — idempotent notification creation.
 *
 * Root cause fixed: sendUpcomingRenewalReminders() deduped the
 * AutomationRun it schedules but called notificationsService.enqueue()
 * for the in-app notification completely unconditionally beforehand —
 * repeated sweeps created a fresh duplicate "Upcoming Regular Delivery"
 * notification every time. Fixed by reusing the SAME convention already
 * established for AutomationRun.dedupeKey / WebhookEvent.stripeEventId: a
 * nullable, DB-level-unique dedupeKey column, so a duplicate insert is a
 * real constraint violation (safe under concurrent execution) rather than
 * an application-level "check then create" race.
 *
 * See src/tests/e2e-notification-dedupe.test.ts for the real-database
 * proof that concurrent creates for the same dedupeKey still produce
 * exactly one row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    notification: { create: vi.fn() },
  },
}));

vi.mock("../lib/expo-push", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../queues", () => ({
  notificationsQueue: null,
}));

import { prisma } from "../lib/prisma";
import { sendPushToUser } from "../lib/expo-push";
import { notificationsService } from "../modules/notifications/notifications.service";

const m = vi.mocked(prisma, true);
const mSendPush = vi.mocked(sendPushToUser);

function p2002(field: string) {
  const error = new Error("Unique constraint failed") as Error & { code: string; meta: { target: string[] } };
  error.code = "P2002";
  error.meta = { target: [field] };
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notificationsService.create — dedupeKey", () => {
  it("creates normally when no dedupeKey is given", async () => {
    m.notification.create.mockResolvedValue({ id: "n1" } as never);
    const result = await notificationsService.create({ userId: "u1", type: "ADMIN_BROADCAST", title: "Hi" });
    expect(result).toEqual({ id: "n1" });
  });

  it("creates normally when dedupeKey is new", async () => {
    m.notification.create.mockResolvedValue({ id: "n2", dedupeKey: "EVENT:1" } as never);
    const result = await notificationsService.create({ userId: "u1", type: "ADMIN_BROADCAST", title: "Hi", dedupeKey: "EVENT:1" });
    expect(result).toEqual({ id: "n2", dedupeKey: "EVENT:1" });
  });

  it("returns null (not an error) when dedupeKey already exists — the DB constraint is what actually prevented the duplicate", async () => {
    m.notification.create.mockRejectedValue(p2002("dedupeKey"));
    const result = await notificationsService.create({ userId: "u1", type: "ADMIN_BROADCAST", title: "Hi", dedupeKey: "EVENT:1" });
    expect(result).toBeNull();
  });

  it("re-throws a unique-constraint violation on an unrelated field instead of misreading it as a dedupe hit", async () => {
    m.notification.create.mockRejectedValue(p2002("id"));
    await expect(
      notificationsService.create({ userId: "u1", type: "ADMIN_BROADCAST", title: "Hi", dedupeKey: "EVENT:1" }),
    ).rejects.toThrow("Unique constraint failed");
  });
});

describe("notificationsService.enqueue — a deduped DB row must also suppress the push, not just the row", () => {
  it("sends the push when the notification is newly created", async () => {
    m.notification.create.mockResolvedValue({ id: "n1" } as never);
    await notificationsService.enqueue({ userId: "u1", type: "ADMIN_BROADCAST", title: "Hi", dedupeKey: "EVENT:1" });
    expect(mSendPush).toHaveBeenCalledTimes(1);
  });

  it("skips the push entirely when dedupeKey already existed — a real duplicate push to the buyer's device is exactly what this must never do", async () => {
    m.notification.create.mockRejectedValue(p2002("dedupeKey"));
    await notificationsService.enqueue({ userId: "u1", type: "ADMIN_BROADCAST", title: "Hi", dedupeKey: "EVENT:1" });
    expect(mSendPush).not.toHaveBeenCalled();
  });

  it("still sends the push when no dedupeKey is used at all — every other notification call site is completely unaffected", async () => {
    m.notification.create.mockResolvedValue({ id: "n1" } as never);
    await notificationsService.enqueue({ userId: "u1", type: "ADMIN_BROADCAST", title: "Hi" });
    expect(mSendPush).toHaveBeenCalledTimes(1);
  });
});
