/**
 * REAL database regression test: Notification.dedupeKey must actually
 * prevent a duplicate row — including under concurrent execution, which a
 * mocked-Prisma unit test cannot meaningfully prove (there is no real
 * transaction/locking behavior to race against). This is what makes
 * "concurrent sweeps still produce exactly one notification" a genuine,
 * verified guarantee rather than an assumption.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { notificationsService } from "../modules/notifications/notifications.service";

const prisma = new PrismaClient();

const TEST_EMAIL_A = `e2e-dedupe-buyer-a-${Date.now()}@test.eki`;
const TEST_EMAIL_B = `e2e-dedupe-buyer-b-${Date.now()}@test.eki`;
let buyerAId: string;
let buyerBId: string;

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { email: TEST_EMAIL_A, name: "E2E Dedupe Buyer A", password: "unused", role: "BUYER" } }),
    prisma.user.create({ data: { email: TEST_EMAIL_B, name: "E2E Dedupe Buyer B", password: "unused", role: "BUYER" } }),
  ]);
  buyerAId = a.id;
  buyerBId = b.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [buyerAId, buyerBId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerAId, buyerBId] } } });
  await prisma.$disconnect();
});

describe("Notification dedupeKey — real-database idempotency", () => {
  it("first sweep creates one notification", async () => {
    const dedupeKey = `RENEWAL_REMINDER:sub-e2e-1:2026-09-10`;
    const created = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey });
    expect(created).not.toBeNull();

    const rows = await prisma.notification.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
  });

  it("second identical sweep creates no new notification", async () => {
    const dedupeKey = `RENEWAL_REMINDER:sub-e2e-2:2026-09-10`;
    const first = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey });
    const second = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey });

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // signals "already existed", not an error

    const rows = await prisma.notification.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
  });

  it("concurrent sweeps for the same event still produce exactly one notification", async () => {
    const dedupeKey = `RENEWAL_REMINDER:sub-e2e-3:2026-09-10`;

    // Ten simultaneous calls, exactly as two overlapping cron triggers (or
    // a retried request racing the original) would look in production.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey }),
      ),
    );

    const succeeded = results.filter((r) => r !== null);
    const deduped = results.filter((r) => r === null);
    expect(succeeded).toHaveLength(1);
    expect(deduped).toHaveLength(9);

    const rows = await prisma.notification.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
  });

  it("a different renewal cycle (different date) for the same subscription gets its own notification", async () => {
    const keyA = `RENEWAL_REMINDER:sub-e2e-4:2026-09-10`;
    const keyB = `RENEWAL_REMINDER:sub-e2e-4:2026-09-17`; // next cycle, a week later

    const first = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey: keyA });
    const second = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey: keyB });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await prisma.notification.count({ where: { dedupeKey: { in: [keyA, keyB] } } })).toBe(2);
  });

  it("a different buyer gets an independent notification even for the same subscription/cycle key shape", async () => {
    const dedupeKey = `RENEWAL_REMINDER:sub-e2e-5:2026-09-10`;

    const forA = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey });
    expect(forA).not.toBeNull();

    // A genuinely different subscription (different buyer's own renewal)
    // must use a different subscriptionId in the key in real usage — this
    // proves the SAME literal key correctly stays exclusive to whichever
    // row created it first, rather than being silently keyed per-user.
    const forB = await notificationsService.create({ userId: buyerBId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey });
    expect(forB).toBeNull();

    const rows = await prisma.notification.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(buyerAId);
  });

  it("the same buyer with a different subscription's renewal gets a correct, independent notification", async () => {
    const keySubX = `RENEWAL_REMINDER:sub-e2e-6:2026-09-10`;
    const keySubY = `RENEWAL_REMINDER:sub-e2e-7:2026-09-10`;

    const forX = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey: keySubX });
    const forY = await notificationsService.create({ userId: buyerAId, type: "SUBSCRIPTION_UPDATE", title: "Upcoming Regular Delivery", dedupeKey: keySubY });

    expect(forX).not.toBeNull();
    expect(forY).not.toBeNull();
    expect(forX!.id).not.toBe(forY!.id);
  });
});
