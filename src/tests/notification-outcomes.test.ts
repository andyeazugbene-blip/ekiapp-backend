import { describe, expect, it, vi } from "vitest";
import { recordNotificationOutcomes, recordNotificationTaskCompletion } from "../modules/notifications/notification-outcomes";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { notification: { findMany: vi.fn() }, notificationOutcome: { upsert: vi.fn() } },
}));
vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));
import { prisma } from "../lib/prisma";

describe("notification outcome attribution", () => {
  it("attributes a source-backed order-delivered transition to the R22 task episode", async () => {
    const tx = {
      notification: { findMany: vi.fn().mockResolvedValue([{ id: "notification-22" }]) },
      notificationOutcome: { upsert: vi.fn().mockResolvedValue({}) },
    } as never;
    const occurredAt = new Date("2026-10-27T12:00:00.000Z");

    await expect(recordNotificationOutcomes(tx, {
      id: "event-delivered-22", name: "order_delivered", occurredAt, payload: { orderId: "order-22" },
    } as never)).resolves.toBe(1);

    expect(tx.notification.findMany).toHaveBeenCalledWith({
      where: { ruleId: "R22_ORDER_DISPATCHED", entityType: "Order", entityId: "order-22" }, select: { id: true },
    });
    expect(tx.notificationOutcome.upsert).toHaveBeenCalledWith({
      where: { notificationId: "notification-22" },
      create: {
        notificationId: "notification-22", completedAt: occurredAt,
        completionEventId: "event-delivered-22", attributionModel: "DIRECT_TASK_COMPLETION",
      },
      update: {},
    });
  });

  it("does not treat product publication as completion of an R08 approval alert", async () => {
    const tx = {
      notification: { findMany: vi.fn() },
      notificationOutcome: { upsert: vi.fn() },
    } as never;
    await expect(recordNotificationOutcomes(tx, {
      id: "event-product-published", name: "product_published", occurredAt: new Date(), payload: { vendorId: "vendor-8" },
    } as never)).resolves.toBe(0);
    expect(tx.notification.findMany).not.toHaveBeenCalled();
    expect(tx.notificationOutcome.upsert).not.toHaveBeenCalled();
  });

  it("attributes user-confirmed completion only to the matching recipient and task entity", async () => {
    const findMany = vi.mocked(prisma.notification.findMany);
    const upsert = vi.mocked(prisma.notificationOutcome.upsert);
    findMany.mockResolvedValue([{ id: "notification-1" }] as never);
    upsert.mockResolvedValue({} as never);
    await expect(recordNotificationTaskCompletion({ userId: "buyer-1", ruleId: "R21_ORDER_CONFIRMED", entityType: "Order", entityId: "order-1" })).resolves.toBe(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "buyer-1", ruleId: "R21_ORDER_CONFIRMED", entityType: "Order", entityId: "order-1" },
      select: { id: true },
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { notificationId: "notification-1" } }));
  });
});
