import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock } = vi.hoisted(() => {
  const txMock = {
    event: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  };
  return {
    txMock,
    prismaMock: {
      event: { upsert: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    },
  };
});

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));

import { eventOutboxService, validateOutboxEvent } from "../modules/events/event-outbox.service";

const event = {
  id: "event-1", name: "payment_succeeded", schemaVersion: 1, dedupeKey: "payment:1",
  deliveryStatus: "PENDING", deliveryAttempt: 0, availableAt: new Date("2026-01-01T00:00:00Z"),
  occurredAt: new Date("2026-01-01T00:00:00Z"), payload: { paymentId: "payment-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.event.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.event.findMany.mockResolvedValue([]);
  txMock.event.findUnique.mockResolvedValue({ ...event, deliveryStatus: "PROCESSING" });
  txMock.event.update.mockResolvedValue({ ...event, deliveryStatus: "DELIVERED" });
  txMock.event.updateMany.mockResolvedValue({ count: 1 });
});

describe("event outbox envelope", () => {
  it("accepts a known v1 canonical event with an object payload", () => {
    expect(() => validateOutboxEvent({ name: "payment_succeeded", payload: { paymentId: "payment-1" }, schemaVersion: 1 }))
      .not.toThrow();
  });

  it("rejects unknown names, unsupported versions, and non-object payloads", () => {
    expect(() => validateOutboxEvent({ name: "invented_event", schemaVersion: 1 })).toThrow("Unknown canonical event name");
    expect(() => validateOutboxEvent({ name: "payment_succeeded", schemaVersion: 2 })).toThrow("Unsupported event schema version");
    expect(() => validateOutboxEvent({ name: "payment_succeeded", payload: [] as never, schemaVersion: 1 })).toThrow("payload must be an object");
  });

  it("writes an idempotent pending event through the caller transaction", async () => {
    prismaMock.event.upsert = vi.fn();
    const tx = { event: { upsert: vi.fn().mockResolvedValue(event) } } as never;
    await eventOutboxService.enqueue(tx, { name: "payment_succeeded", entityType: "Payment", entityId: "payment-1", payload: { paymentId: "payment-1" } }, { dedupeKey: "payment:1" });
    expect((tx as any).event.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "payment:1" },
      create: expect.objectContaining({ schemaVersion: 1, deliveryStatus: "PENDING", dedupeKey: "payment:1" }),
      update: {},
    }));
  });
});

describe("event outbox consumer", () => {
  it("leaves events pending when no canonical handler is registered", async () => {
    prismaMock.event.findMany.mockResolvedValue([event] as never);
    const result = await eventOutboxService.dispatchBatch({}, 10, new Date("2026-01-01T00:01:00Z"));
    expect(result).toMatchObject({ claimed: 0, unhandled: 1 });
    expect(prismaMock.event.updateMany).toHaveBeenCalledTimes(1); // stale-lease recovery only
  });

  it("claims, handles, and marks the event delivered in one transaction", async () => {
    prismaMock.event.findMany.mockResolvedValue([event] as never);
    prismaMock.event.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const handler = vi.fn().mockResolvedValue(undefined);
    const result = await eventOutboxService.dispatchBatch({ payment_succeeded: handler }, 10, new Date("2026-01-01T00:01:00Z"));
    expect(result).toMatchObject({ claimed: 1, delivered: 1 });
    expect(handler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "event-1" }));
    expect(txMock.event.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "event-1" }, data: expect.objectContaining({ deliveryStatus: "DELIVERED" }),
    }));
  });

  it("schedules failed handlers for retry with a bounded delay", async () => {
    prismaMock.event.findMany.mockResolvedValue([event] as never);
    prismaMock.event.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const handler = vi.fn().mockRejectedValue(new Error("temporary consumer error"));
    const now = new Date("2026-01-01T00:01:00Z");
    const result = await eventOutboxService.dispatchBatch({ payment_succeeded: handler }, 10, now);
    expect(result).toMatchObject({ claimed: 1, retried: 1 });
    expect(prismaMock.event.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "event-1", deliveryStatus: "PROCESSING" },
      data: expect.objectContaining({ deliveryStatus: "PENDING", availableAt: new Date(now.getTime() + 5_000), lastDeliveryError: "temporary consumer error" }),
    }));
  });

  it("dead-letters an event after its final permitted handler attempt", async () => {
    prismaMock.event.findMany.mockResolvedValue([{ ...event, deliveryAttempt: 7 }] as never);
    prismaMock.event.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const handler = vi.fn().mockRejectedValue(new Error("permanent consumer failure"));
    const result = await eventOutboxService.dispatchBatch({ payment_succeeded: handler }, 10, new Date("2026-01-01T00:01:00Z"));
    expect(result).toMatchObject({ claimed: 1, dead: 1 });
    expect(prismaMock.event.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryStatus: "DEAD", lastDeliveryError: "permanent consumer failure" }),
    }));
  });
});
