import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, sendPushToUser } = vi.hoisted(() => {
  const eventRow: Record<string, any> = {};
  let notificationRow: Record<string, any> | null = null;
  let deliveryRow: Record<string, any> | null = null;
  const txMock: any = {
    event: {
      upsert: vi.fn(async ({ create }: any) => Object.assign(eventRow, { id: "event-1", deliveryAttempt: 0, deliveryStatus: "PENDING", ...create })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(async () => ({ ...eventRow, deliveryStatus: "PROCESSING" })),
      update: vi.fn(async ({ data }: any) => Object.assign(eventRow, data)),
    },
    message: {
      findUnique: vi.fn().mockResolvedValue({
        id: "message-1", conversationId: "conversation-1", senderId: "admin-1", isInternal: false, readAt: null,
        conversation: { id: "conversation-1", type: "SUPPORT", status: "OPEN", participantA: "admin-1", participantB: "buyer-1" },
      }),
    },
    user: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    campaignContribution: { findMany: vi.fn() },
    payoutRequest: { findUnique: vi.fn() },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        notificationRow = { id: "notification-1", readAt: null, ...data };
        return notificationRow;
      }),
      findUnique: vi.fn(async () => notificationRow),
    },
    notificationDelivery: {
      upsert: vi.fn(async ({ create }: any) => {
        deliveryRow = { id: "delivery-1", attempt: 0, status: "PENDING", ...create };
        return deliveryRow;
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    communicationLog: { create: vi.fn().mockResolvedValue({ id: "log-1" }) },
  };
  const prismaMock: any = {
    event: {
      upsert: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(async () => [{ ...eventRow, deliveryStatus: "PENDING" }]),
    },
    notificationDelivery: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(async () => deliveryRow ? [{ ...deliveryRow, notification: notificationRow }] : []),
      findUnique: vi.fn(async () => ({ id: "delivery-1", attempt: 1, status: "SENT" })),
    },
    message: txMock.message,
    user: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    campaignContribution: { findMany: vi.fn() },
    payoutRequest: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    communicationLog: { update: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
  };
  return { prismaMock, txMock, sendPushToUser: vi.fn() };
});

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../lib/expo-push", () => ({ sendPushToUser }));
vi.mock("../queues", () => ({ notificationsQueue: null }));

import { eventOutboxService } from "../modules/events/event-outbox.service";
import { registerCoreEventHandlers } from "../modules/events/core-event-handlers";
import { EVENT_NAMES } from "../modules/events/events.service";
import { notificationDeliveryService } from "../modules/notifications/notification-delivery.service";

describe("event to notification pipeline integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("R28_GENERAL_SUPPORT_NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("R34_COMMUNITY_BUY_BELOW_MINIMUM_ENABLED", "true");
    vi.stubEnv("R26_PAYOUT_CONFIRMED_ENABLED", "true");
    vi.stubEnv("R37_SUPPLIER_RECONFIRMATION_ENABLED", "false");
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["expo-ticket-1"] });
    txMock.user.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      role: where.id === "admin-1" ? "ADMIN" : "BUYER",
      isSuspended: false,
    }));
    prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      role: where.id === "admin-1" ? "ADMIN" : "BUYER",
      isSuspended: false,
    }));
    txMock.communityCampaign.findUnique.mockResolvedValue({
      id: "campaign-1", title: "Rice", status: "LIVE", minimumShares: 5, confirmedShares: 6,
      organiser: { userId: "buyer-1" },
    });
    prismaMock.communityCampaign.findUnique.mockResolvedValue({
      id: "campaign-1", status: "LIVE", minimumShares: 5, confirmedShares: 6,
      organiser: { userId: "buyer-1" },
    });
    registerCoreEventHandlers();
  });

  it("validates and enqueues a domain event, resolves R28, creates one idempotent candidate, delivers push, and records outcomes", async () => {
    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.support_response_received,
      actorType: "admin",
      actorId: "admin-1",
      entityType: "Conversation",
      entityId: "conversation-1",
      payload: { conversationId: "conversation-1", messageId: "message-1" },
    }, { dedupeKey: "support-response:message-1", schemaVersion: 1 }));

    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledTimes(1);
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "buyer-1",
      dedupeKey: "R28_SUPPORT_THREAD_REPLY:message-1",
      data: expect.objectContaining({ ruleKey: "R28_SUPPORT_RESPONSE", ruleVersion: 1, eventId: event.id }),
    }) });
    expect(txMock.notificationDelivery.upsert).toHaveBeenCalledTimes(1);
    expect(txMock.event.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: event.id }, data: expect.objectContaining({ deliveryStatus: "DELIVERED" }),
    }));

    const deliveryResult = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(deliveryResult).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-1", expect.objectContaining({
      title: "Eki Support has replied",
      data: expect.objectContaining({ ruleKey: "R28_SUPPORT_RESPONSE", eventId: event.id }),
    }), { logId: "log-1" });
    expect(txMock.communicationLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventKey: "notification_delivery:delivery-1:attempt:1", status: "QUEUED" }),
    }));

    await notificationDeliveryService.recordReceipt("log-1", true, "ok");
    expect(prismaMock.notificationDelivery.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "delivery-1", status: "SENT" },
      data: expect.objectContaining({ status: "DELIVERED", deliveredAt: expect.any(Date) }),
    }));
  });

  it("routes confirmed Community Buy minimum events to the organiser through the durable delivery path", async () => {
    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.community_buy_minimum_reached,
      actorType: "system",
      entityType: "CommunityCampaign",
      entityId: "campaign-1",
      payload: { campaignId: "campaign-1", confirmedShares: 6, minimumShares: 5 },
    }, { dedupeKey: "R35_COMMUNITY_BUY_MINIMUM_REACHED:campaign-1", schemaVersion: 1 }));

    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "buyer-1", title: "Your Community Buy reached its minimum",
      data: expect.objectContaining({ ruleKey: "R35_COMMUNITY_BUY_MINIMUM_REACHED", eventId: event.id }),
    }) });

    const deliveryResult = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(deliveryResult).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-1", expect.objectContaining({
      title: "Your Community Buy reached its minimum",
      data: expect.objectContaining({ destination: "community_buy_campaign", audience: "organiser", campaignId: "campaign-1" }),
    }), { logId: "log-1" });
  });

  it("routes a real below-minimum rescue-window event to the organiser and rechecks before delivery", async () => {
    const deadline = new Date("2026-10-27T12:00:00Z");
    txMock.communityCampaign.findUnique.mockResolvedValue({
      id: "campaign-1", title: "Rice", status: "RESCUE_WINDOW", minimumShares: 5, confirmedShares: 3,
      rescueEndsAt: deadline, organiser: { userId: "buyer-1" },
    });
    prismaMock.communityCampaign.findUnique.mockResolvedValue({
      status: "RESCUE_WINDOW", minimumShares: 5, confirmedShares: 3, rescueEndsAt: deadline,
      organiser: { userId: "buyer-1" },
    });
    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.community_buy_below_minimum,
      actorType: "system",
      entityType: "CommunityCampaign",
      entityId: "campaign-1",
      payload: { campaignId: "campaign-1", minimumShares: 5, confirmedShares: 3, remainingShares: 2, rescueDeadline: deadline.toISOString() },
    }, { dedupeKey: "R34_COMMUNITY_BUY_BELOW_MINIMUM:campaign-1", schemaVersion: 1 }));

    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "buyer-1", title: "Your Community Buy needs 2 shares",
      body: `Review your available options before ${deadline.toISOString()}.`,
      data: expect.objectContaining({ ruleKey: "R34_COMMUNITY_BUY_BELOW_MINIMUM", eventId: event.id, destination: "community_buy_campaign", audience: "organiser" }),
    }) });

    const result = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-1", expect.objectContaining({
      title: "Your Community Buy needs 2 shares",
      data: expect.objectContaining({ campaignId: "campaign-1", remainingShares: 2, deadline: deadline.toISOString() }),
    }), { logId: "log-1" });
  });

  it("uses successful authorisations, not pledge counters, for the R34 decision-required quantity", async () => {
    const decisionRequiredAt = new Date("2026-10-26T10:00:00Z");
    const deadline = new Date(decisionRequiredAt.getTime() + 24 * 60 * 60 * 1000);
    txMock.communityCampaign.findUnique.mockResolvedValue({
      id: "campaign-1", title: "Rice", status: "DECISION_REQUIRED", paymentMode: "AUTHORISE_THEN_CAPTURE",
      minimumShares: 10, confirmedShares: 9, decisionRequiredAt, organiser: { userId: "buyer-1" },
    });
    txMock.campaignContribution.findMany.mockResolvedValue([{ quantity: 3 }]);
    prismaMock.communityCampaign.findUnique.mockResolvedValue({
      status: "DECISION_REQUIRED", paymentMode: "AUTHORISE_THEN_CAPTURE", minimumShares: 10,
      confirmedShares: 9, decisionRequiredAt, organiser: { userId: "buyer-1" },
    });
    prismaMock.campaignContribution.findMany.mockResolvedValue([{ quantity: 3 }]);
    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.community_buy_below_minimum,
      actorType: "system",
      entityType: "CommunityCampaign",
      entityId: "campaign-1",
      payload: { campaignId: "campaign-1", minimumShares: 10, confirmedShares: 3, remainingShares: 7, rescueDeadline: deadline.toISOString() },
    }, { dedupeKey: "R34_COMMUNITY_BUY_BELOW_MINIMUM:campaign-1", schemaVersion: 1 }));

    await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      title: "Your Community Buy needs 7 shares",
      body: `Review your available options before ${deadline.toISOString()}.`,
      data: expect.objectContaining({ eventId: event.id, remainingShares: 7 }),
    }) });
    const delivery = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(delivery).toMatchObject({ claimed: 1, sent: 1 });
  });

  it("delivers an R26 candidate only after the payout is PAID and confirms its provider receipt", async () => {
    txMock.payoutRequest.findUnique.mockResolvedValue({ id: "payout-2", status: "PAID", vendor: { userId: "vendor-1" } });
    prismaMock.payoutRequest.findUnique.mockResolvedValue({ status: "PAID", vendor: { userId: "vendor-1" } });
    txMock.user.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, role: "VENDOR", isSuspended: false }));
    prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, role: "VENDOR", isSuspended: false }));
    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.payout_confirmed,
      actorType: "admin",
      entityType: "PayoutRequest",
      entityId: "payout-2",
      payload: { payoutRequestId: "payout-2" },
    }, { dedupeKey: "payout_confirmed:payout-2", schemaVersion: 1 }));
    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "vendor-1", title: "Your payout has been completed", body: "View the transaction details.",
      data: expect.objectContaining({ ruleKey: "R26_PAYOUT_CONFIRMED", eventId: event.id, payoutRequestId: "payout-2" }),
    }) });
    const deliveryResult = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(deliveryResult).toMatchObject({ claimed: 1, sent: 1 });
    await notificationDeliveryService.recordReceipt("log-1", true, "ok");
    expect(prismaMock.notificationDelivery.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "delivery-1", status: "SENT" }, data: expect.objectContaining({ status: "DELIVERED" }),
    }));
  });
});
