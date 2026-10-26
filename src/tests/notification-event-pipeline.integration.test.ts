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
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    paymentAnomaly: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    vendor: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
    campaignContribution: { findMany: vi.fn() },
    payoutRequest: { findUnique: vi.fn() },
    vendorSubscription: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    productInventoryCount: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    orderItem: { aggregate: vi.fn() },
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
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    paymentAnomaly: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    vendor: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    communityBuyPaymentAuthorisation: { findUnique: vi.fn() },
    campaignContribution: { findMany: vi.fn() },
    payoutRequest: { findUnique: vi.fn() },
    vendorSubscription: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    productInventoryCount: { findUnique: vi.fn(), findFirst: vi.fn() },
    orderItem: { aggregate: vi.fn() },
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
import { inventoryCountsService } from "../modules/products/inventory-counts.service";
import { ensureCriticalIncidentCandidates } from "../modules/ledger/critical-incident-notifications";

describe("event to notification pipeline integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("R28_GENERAL_SUPPORT_NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("R12_FIRST_PAID_ORDER_ENABLED", "false");
    vi.stubEnv("R21_ORDER_CONFIRMED_ENABLED", "false");
    vi.stubEnv("R22_ORDER_DISPATCHED_ENABLED", "false");
    vi.stubEnv("R34_COMMUNITY_BUY_BELOW_MINIMUM_ENABLED", "true");
    vi.stubEnv("R26_PAYOUT_CONFIRMED_ENABLED", "true");
    vi.stubEnv("R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED_ENABLED", "false");
    vi.stubEnv("R29_MEMBERSHIP_PAYMENT_FAILED_ENABLED", "false");
    vi.stubEnv("R37_SUPPLIER_RECONFIRMATION_ENABLED", "false");
    vi.stubEnv("R40_PAYMENT_ANOMALY_ALERTS_ENABLED", "false");
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

  it("routes a transactional verified dispatch event to the buyer with the R22 copy", async () => {
    vi.stubEnv("R22_ORDER_DISPATCHED_ENABLED", "true");
    txMock.order.findUnique.mockResolvedValue({ id: "order-22", orderNumber: "EKI-22", buyerId: "buyer-22", status: "DELIVERED" });
    prismaMock.order.findUnique.mockResolvedValue({ buyerId: "buyer-22", status: "DELIVERED" });
    txMock.user.findUnique.mockResolvedValue({ id: "buyer-22", role: "BUYER", isSuspended: false });
    prismaMock.user.findUnique.mockResolvedValue({ id: "buyer-22", role: "BUYER", isSuspended: false });

    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.order_dispatched, actorType: "vendor", entityType: "Order", entityId: "order-22",
      payload: { orderId: "order-22", fromStatus: "CONFIRMED" },
    }, { dedupeKey: "order-dispatched:order-22", schemaVersion: 1 }));
    const outbox = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-27T12:00:00Z"));
    expect(outbox).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "buyer-22", title: "Your foodstuff is on its way", body: "View the latest delivery information.",
      dedupeKey: "R22_ORDER_DISPATCHED:order-22",
      data: expect.objectContaining({ ruleKey: "R22_ORDER_DISPATCHED", eventId: event.id, destination: "order_detail", orderId: "order-22" }),
    }) });
    const delivery = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-27T12:00:01Z"));
    expect(delivery).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-22", expect.objectContaining({
      title: "Your foodstuff is on its way", body: "View the latest delivery information.",
      data: expect.objectContaining({ type: "buyer_order_dispatched", destination: "order_detail", orderId: "order-22" }),
    }), { logId: "log-1" });
  });

  it("routes a transactional vendor-acceptance event to the buyer with the R21 v2 copy", async () => {
    vi.stubEnv("R21_ORDER_CONFIRMED_ENABLED", "true");
    txMock.order.findUnique.mockResolvedValue({ id: "order-21", orderNumber: "EKI-21", buyerId: "buyer-21", status: "PROCESSING" });
    prismaMock.order.findUnique.mockResolvedValue({ buyerId: "buyer-21", status: "PROCESSING" });
    txMock.user.findUnique.mockResolvedValue({ id: "buyer-21", role: "BUYER", isSuspended: false });
    prismaMock.user.findUnique.mockResolvedValue({ id: "buyer-21", role: "BUYER", isSuspended: false });

    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.order_accepted, actorType: "vendor", entityType: "Order", entityId: "order-21",
      payload: { orderId: "order-21", fromStatus: "PAID" },
    }, { dedupeKey: "order-confirmed:evt-21:order-21", schemaVersion: 1 }));
    const outbox = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-27T12:00:00Z"));
    expect(outbox).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "buyer-21", title: "Your order is confirmed", body: "Track your foodstuff order in Eki.",
      dedupeKey: "R21_ORDER_CONFIRMED:order-21",
      data: expect.objectContaining({ ruleKey: "R21_ORDER_CONFIRMED", eventId: event.id, destination: "order_detail", orderId: "order-21" }),
    }) });
    const delivery = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-27T12:00:01Z"));
    expect(delivery).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-21", expect.objectContaining({
      title: "Your order is confirmed", body: "Track your foodstuff order in Eki.",
      data: expect.objectContaining({ type: "buyer_order_confirmed", destination: "order_detail", orderId: "order-21" }),
    }), { logId: "log-1" });
  });

  it("routes a transactional paid-order event to one vendor candidate and durable push", async () => {
    vi.stubEnv("R12_FIRST_PAID_ORDER_ENABLED", "true");
    txMock.order.findUnique.mockResolvedValue({
      id: "order-12", orderNumber: "EKI-12", status: "PAID", vendorConfirmedAt: null,
      vendorId: "vendor-12", items: [],
    });
    prismaMock.order.findUnique.mockResolvedValue({ status: "PAID", vendorConfirmedAt: null, vendorId: "vendor-12", items: [] });
    txMock.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-12" });
    prismaMock.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-12" });
    txMock.user.findUnique.mockResolvedValue({ id: "vendor-user-12", role: "VENDOR", isSuspended: false });
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-user-12", role: "VENDOR", isSuspended: false });

    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.payment_succeeded,
      actorType: "stripe", entityType: "Order", entityId: "order-12",
      payload: { orderId: "order-12", stripeEventId: "evt-12" },
    }, { dedupeKey: "payment-succeeded:evt-12:order-12", schemaVersion: 1 }));
    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-27T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "vendor-user-12", title: "You have a new paid order",
      body: "Review the order and confirm fulfilment.", dedupeKey: "R12_FIRST_PAID_ORDER:order-12",
      data: expect.objectContaining({ ruleKey: "R12_FIRST_PAID_ORDER", eventId: event.id, destination: "order_detail", orderId: "order-12" }),
    }) });
    const delivery = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-27T12:00:01Z"));
    expect(delivery).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("vendor-user-12", expect.objectContaining({
      title: "You have a new paid order", body: "Review the order and confirm fulfilment.",
      data: expect.objectContaining({ type: "vendor_order_paid", destination: "order_detail", orderId: "order-12" }),
    }), { logId: "log-1" });

    vi.stubEnv("R12_FIRST_PAID_ORDER_ENABLED", "false");
    await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-27T12:01:00Z"));
    expect(txMock.notification.create).toHaveBeenCalledTimes(1);
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

  it("routes a physical stocktake conflict without counting checkout-reserved quantities twice", async () => {
    vi.stubEnv("R18_STOCK_CONFLICT_ENABLED", "true");
    const count = { id: "count-1", productId: "product-1", physicalQuantity: 3, outstandingOrderQuantity: 5, shortfallQuantity: 2, stockVersion: 4, createdAt: new Date("2026-10-26T11:00:00Z") };
    txMock.productInventoryCount.findUnique.mockResolvedValue(count);
    prismaMock.productInventoryCount.findUnique.mockResolvedValue(count);
    prismaMock.productInventoryCount.findFirst.mockResolvedValue({ id: "count-1" });
    // Five real units remain outstanding; Product.stock is deliberately not
    // added to that number because checkout already deducted it.
    const orderQuantity = async ({ where }: any) => ({ _sum: { quantity: where.order.deliveredAt ? null : 5 } });
    txMock.orderItem.aggregate.mockImplementation(orderQuantity);
    prismaMock.orderItem.aggregate.mockImplementation(orderQuantity);
    const product = { id: "product-1", stock: 0, stockVersion: 4, status: "PUBLISHED", isActive: true, vendor: { userId: "vendor-1" } };
    txMock.product.findUnique.mockResolvedValue(product);
    prismaMock.product.findUnique.mockResolvedValue(product);
    txMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });

    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.product_inventory_conflict_detected,
      actorType: "vendor", actorId: "vendor-1", entityType: "Product", entityId: "product-1",
      payload: { productId: "product-1", inventoryCountId: "count-1", stockVersion: 4 },
    }, { dedupeKey: "product-inventory-conflict:count-1", schemaVersion: 1 }));
    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "vendor-1", type: "INVENTORY_ALERT", title: "Check stock for an active order",
      body: "Available quantity may not cover outstanding orders.", dedupeKey: "R18_STOCK_CONFLICT:count-1",
      data: expect.objectContaining({ ruleKey: "R18_STOCK_CONFLICT", eventId: event.id, destination: "inventory_detail", shortfallQuantity: 2 }),
    }) });
    const delivery = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(delivery).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("vendor-1", expect.objectContaining({
      title: "Check stock for an active order", data: expect.objectContaining({ inventoryCountId: "count-1", destination: "inventory_detail" }),
    }), { logId: "log-1" });
  });

  it("reconciles available stock from a physical count minus already-reserved open orders", async () => {
    const product = { id: "product-1", vendorId: "vendor-profile-1", stock: 8, stockVersion: 3, vendor: { id: "vendor-profile-1", userId: "vendor-1", isSuspended: false } };
    prismaMock.product.findUnique.mockResolvedValue(product);
    txMock.product.findUnique.mockResolvedValue({ stock: 8, stockVersion: 3, vendorId: "vendor-profile-1" });
    txMock.product.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    txMock.product.findUniqueOrThrow = vi.fn().mockResolvedValue({ stockVersion: 4 });
    txMock.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 5 } });
    txMock.productInventoryCount.create.mockResolvedValue({ id: "count-2", shortfallQuantity: 0 });

    await inventoryCountsService.record("vendor-1", "product-1", 7);
    expect(txMock.product.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "product-1", stock: 8, stockVersion: 3 },
      data: { stock: 2, stockVersion: { increment: 1 } },
    }));
    expect(txMock.productInventoryCount.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      productId: "product-1", physicalQuantity: 7, outstandingOrderQuantity: 5, shortfallQuantity: 0,
    }) });
    expect(txMock.event.upsert).not.toHaveBeenCalled();
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

  it("delivers a gated R36 secure-payment-action notification while the hold still requires action", async () => {
    vi.stubEnv("R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED_ENABLED", "true");
    const authorisation = {
      id: "auth-1", holdStatus: "REQUIRES_ACTION", campaignId: "campaign-1",
      contribution: { participant: { userId: "buyer-1" } },
    };
    txMock.communityBuyPaymentAuthorisation.findUnique.mockResolvedValue(authorisation);
    prismaMock.communityBuyPaymentAuthorisation.findUnique.mockResolvedValue(authorisation);
    txMock.user.findUnique.mockResolvedValue({ id: "buyer-1", role: "BUYER", isSuspended: false });
    prismaMock.user.findUnique.mockResolvedValue({ id: "buyer-1", role: "BUYER", isSuspended: false });

    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.community_buy_payment_action_required,
      actorType: "system", entityType: "CommunityBuyPaymentAuthorisation", entityId: "auth-1",
      payload: { authorisationId: "auth-1", campaignId: "campaign-1", contributionId: "contribution-1" },
    }, { dedupeKey: "community-buy-payment-action-required:auth-1", schemaVersion: 1 }));
    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "buyer-1", title: "Your Community Buy payment needs attention",
      body: "Complete the required secure payment step.",
      dedupeKey: "R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED:auth-1",
      data: expect.objectContaining({ ruleKey: "R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED", eventId: event.id, destination: "community_buy_campaign", authorisationId: "auth-1" }),
    }) });

    const deliveryResult = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(deliveryResult).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-1", expect.objectContaining({
      title: "Your Community Buy payment needs attention",
      data: expect.objectContaining({ destination: "community_buy_campaign", campaignId: "campaign-1", authorisationId: "auth-1" }),
    }), { logId: "log-1" });
  });

  it("routes a Stripe Membership failure through the outbox and durable push delivery", async () => {
    vi.stubEnv("R29_MEMBERSHIP_PAYMENT_FAILED_ENABLED", "true");
    txMock.vendorSubscription.findUnique.mockResolvedValue({ id: "vendor-sub-1", vendorId: "vendor-1", status: "PAST_DUE" });
    prismaMock.vendorSubscription.findUnique.mockResolvedValue({ status: "PAST_DUE", vendorId: "vendor-1" });
    txMock.vendor.findUnique.mockResolvedValue({ userId: "vendor-1" });
    prismaMock.vendor.findUnique.mockResolvedValue({ userId: "vendor-1" });
    txMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });

    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.vendor_membership_payment_failed,
      actorType: "stripe", actorId: "evt-invoice-failed-1", entityType: "VendorSubscription", entityId: "vendor-sub-1",
      payload: { subscriptionId: "vendor-sub-1", vendorId: "vendor-1", stripeEventId: "evt-invoice-failed-1", invoiceId: "in-1" },
    }, { dedupeKey: "vendor-membership-payment-failed:evt-invoice-failed-1", schemaVersion: 1 }));

    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "vendor-1", title: "Your Eki Membership payment needs attention", body: "Update your billing details.",
      data: expect.objectContaining({ ruleKey: "R29_MEMBERSHIP_PAYMENT_FAILED", eventId: event.id, destination: "membership", invoiceId: "in-1" }),
    }) });

    const deliveryResult = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(deliveryResult).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("vendor-1", expect.objectContaining({
      title: "Your Eki Membership payment needs attention",
      data: expect.objectContaining({ destination: "membership", vendorSubscriptionId: "vendor-sub-1" }),
    }), { logId: "log-1" });
  });

  it("routes a real supplier reconfirmation request through the outbox, candidate and durable push delivery", async () => {
    vi.stubEnv("R37_SUPPLIER_RECONFIRMATION_ENABLED", "true");
    const requestedAt = new Date("2026-10-26T11:00:00Z");
    const deadline = new Date("2026-10-27T23:00:00Z");
    const campaign = {
      id: "campaign-1", title: "Rice", status: "AWAITING_SUPPLIER_RECONFIRMATION",
      reconfirmationDeadline: deadline, reconfirmationRequestedAt: requestedAt, reconfirmationQuantity: 4,
      supplierAccount: { userId: "supplier-1" }, supplier: null,
    };
    txMock.communityCampaign.findUnique.mockResolvedValue(campaign);
    prismaMock.communityCampaign.findUnique.mockResolvedValue(campaign);

    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.community_buy_supplier_reconfirmation_requested,
      actorType: "user", actorId: "organiser-1", entityType: "CommunityCampaign", entityId: "campaign-1",
      payload: { campaignId: "campaign-1", quantity: 4, requestedAt: requestedAt.toISOString(), deadline: deadline.toISOString() },
    }, { dedupeKey: "community-buy-supplier-reconfirmation:campaign-1:2026-10-26T11:00:00.000Z", schemaVersion: 1 }));

    const outboxResult = await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(outboxResult).toMatchObject({ claimed: 1, delivered: 1 });
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "supplier-1", title: "Please confirm your Community Buy supply",
      body: "Review quantity and fulfilment terms.",
      dedupeKey: "R37_SUPPLIER_RECONFIRMATION:campaign-1:2026-10-26T11:00:00.000Z",
      data: expect.objectContaining({ ruleKey: "R37_SUPPLIER_RECONFIRMATION", ruleVersion: 1, eventId: event.id, destination: "community_buy_campaign", audience: "supplier" }),
    }) });

    const deliveryResult = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(deliveryResult).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("supplier-1", expect.objectContaining({
      title: "Please confirm your Community Buy supply",
      data: expect.objectContaining({ destination: "community_buy_campaign", audience: "supplier", campaignId: "campaign-1", quantity: 4 }),
    }), { logId: "log-1" });
  });

  it("delivers the approved R40 incident copy to an active admin through durable push delivery", async () => {
    vi.stubEnv("R40_PAYMENT_ANOMALY_ALERTS_ENABLED", "true");
    const incident = { id: "incident-1", dedupeKey: "OUTBOX_EVENT_FAILURE:event-1", kind: "OUTBOX_EVENT_FAILURE", severity: "CRITICAL", status: "OPEN", businessRefType: "Event", businessRefId: "event-1" };
    txMock.user.findMany.mockResolvedValue([{ id: "admin-1" }]);
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN", isSuspended: false });
    prismaMock.paymentAnomaly.findUnique.mockResolvedValue(incident);
    await ensureCriticalIncidentCandidates(txMock, incident as any);

    const result = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("admin-1", expect.objectContaining({
      title: "A critical Eki process needs attention", body: "Open the incident and review the failed job.",
      data: expect.objectContaining({ destination: "admin_case", incidentId: "incident-1", severity: "CRITICAL" }),
    }), { logId: "log-1" });
  });

  it("cancels an R40 delivery after the admin resolves its incident", async () => {
    vi.stubEnv("R40_PAYMENT_ANOMALY_ALERTS_ENABLED", "true");
    const incident = { id: "incident-2", dedupeKey: "OUTBOX_EVENT_FAILURE:event-2", kind: "OUTBOX_EVENT_FAILURE", severity: "CRITICAL", status: "OPEN", businessRefType: "Event", businessRefId: "event-2" };
    txMock.user.findMany.mockResolvedValue([{ id: "admin-1" }]);
    await ensureCriticalIncidentCandidates(txMock, incident as any);
    prismaMock.paymentAnomaly.findUnique.mockResolvedValue({ ...incident, status: "RESOLVED" });
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN", isSuspended: false });

    const result = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("cancels an R29 delivery if payment is resolved before the send-time check", async () => {
    vi.stubEnv("R29_MEMBERSHIP_PAYMENT_FAILED_ENABLED", "true");
    txMock.vendorSubscription.findUnique.mockResolvedValue({ id: "vendor-sub-1", vendorId: "vendor-1", status: "PAST_DUE" });
    txMock.vendor.findUnique.mockResolvedValue({ userId: "vendor-1" });
    txMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });
    const event = await prismaMock.$transaction((tx: typeof txMock) => eventOutboxService.enqueue(tx, {
      name: EVENT_NAMES.vendor_membership_payment_failed,
      actorType: "stripe", actorId: "evt-invoice-failed-2", entityType: "VendorSubscription", entityId: "vendor-sub-1",
      payload: { subscriptionId: "vendor-sub-1", vendorId: "vendor-1", stripeEventId: "evt-invoice-failed-2", invoiceId: "in-2" },
    }, { dedupeKey: "vendor-membership-payment-failed:evt-invoice-failed-2", schemaVersion: 1 }));
    await eventOutboxService.dispatchRegisteredBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(txMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      data: expect.objectContaining({ eventId: event.id, ruleKey: "R29_MEMBERSHIP_PAYMENT_FAILED" }),
    }) });

    prismaMock.vendorSubscription.findUnique.mockResolvedValue({ status: "ACTIVE", vendorId: "vendor-1" });
    const result = await notificationDeliveryService.dispatchBatch(10, new Date("2026-10-26T12:00:00Z"));
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
