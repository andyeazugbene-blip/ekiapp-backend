import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, sendPushToUser } = vi.hoisted(() => {
  const txMock = {
    communicationLog: { create: vi.fn() },
    notificationDelivery: { updateMany: vi.fn() },
    notification: { update: vi.fn() },
  };
  return {
    txMock,
    sendPushToUser: vi.fn(),
    prismaMock: {
      notificationDelivery: { updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
      notification: { update: vi.fn() },
      notificationPreference: { findUnique: vi.fn().mockResolvedValue(null) },
      message: { findUnique: vi.fn() },
      product: { findUnique: vi.fn() },
      communityCampaign: { findUnique: vi.fn() },
      campaignContribution: { findMany: vi.fn() },
      payoutRequest: { findUnique: vi.fn() },
      shipment: { findUnique: vi.fn() },
      event: { findFirst: vi.fn() },
      order: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
      communicationLog: { update: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    },
  };
});

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../lib/expo-push", () => ({ sendPushToUser }));
const mockGetWhatsappCooldownSeconds = vi.fn().mockResolvedValue(0);
vi.mock("../modules/admin/admin-platform-settings.service", () => ({
  adminPlatformSettingsService: { getWhatsappCooldownSeconds: () => mockGetWhatsappCooldownSeconds() },
}));

import { notificationDeliveryService } from "../modules/notifications/notification-delivery.service";

const now = new Date("2026-10-26T12:00:00.000Z");
const delivery = {
  id: "delivery-1", attempt: 0, status: "PENDING", channel: "push",
  notification: {
    id: "notification-1", userId: "buyer-1", title: "Eki Support has replied",
    body: "Open your case to read the update.", readAt: null,
    data: { type: "support_case_response", ruleKey: "R28_SUPPORT_RESPONSE", ruleVersion: 1, destination: "support_case", conversationId: "conversation-1", messageId: "message-1" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWhatsappCooldownSeconds.mockResolvedValue(0);
  vi.stubEnv("R28_GENERAL_SUPPORT_NOTIFICATIONS_ENABLED", "true");
  vi.stubEnv("R35_COMMUNITY_BUY_MINIMUM_REACHED_ENABLED", "false");
  vi.stubEnv("R24_DELIVERY_EXCEPTION_ENABLED", "false");
  prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.notificationDelivery.findMany.mockResolvedValue([delivery]);
  prismaMock.message.findUnique.mockResolvedValue({
    id: "message-1", conversationId: "conversation-1", senderId: "admin-1", isInternal: false, readAt: null,
    conversation: { id: "conversation-1", type: "SUPPORT", status: "OPEN", participantA: "admin-1", participantB: "buyer-1" },
  });
  prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id, role: where.id === "admin-1" ? "ADMIN" : "BUYER", isSuspended: false,
  }));
  txMock.communicationLog.create.mockResolvedValue({ id: "log-1" });
  txMock.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.communicationLog.update.mockResolvedValue({ id: "log-1" });
  prismaMock.product.findUnique.mockResolvedValue({
    id: "product-1", vendor: { userId: "vendor-1" }, isActive: true, status: "PUBLISHED", stock: 0, stockVersion: 4,
  });
  prismaMock.communityCampaign.findUnique.mockResolvedValue({
    status: "LIVE", minimumShares: 5, confirmedShares: 6, organiser: { userId: "buyer-1" },
  });
});

describe("notification push delivery", () => {
  it("defers service candidates to the recipient's local quiet-hours end", async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue({
      consent: "NOT_REQUIRED_FOR_SERVICE", timezone: "UTC", quietHoursStart: "11:00", quietHoursEnd: "13:00",
    } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, role: "BUYER", category: "SERVICE", priority: "P1",
        taskEpisodeKey: "buyer-1:BUYER:Order:order-1:R21_ORDER_CONFIRMED:event-1", data: { type: "buyer_order_confirmed" } },
    }] as never);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 0 });
    expect(prismaMock.notificationDelivery.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "delivery-1", status: "PROCESSING", lockedAt: now },
      data: expect.objectContaining({ status: "PENDING", availableAt: new Date("2026-10-26T13:00:00.000Z"), attempt: { decrement: 1 } }),
    }));
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("requires explicit push marketing consent at send time", async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, role: "BUYER", category: "MARKETING", priority: "P2",
        data: { type: "buyer_win_back" } },
    }] as never);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(txMock.notification.update).toHaveBeenCalledWith({ where: { id: "notification-1" }, data: { candidateState: "SUPPRESSED" } });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("suppresses push when the same task episode was already delivered by WhatsApp", async () => {
    mockGetWhatsappCooldownSeconds.mockResolvedValue(3600);
    const taskEpisodeKey = "buyer-1:BUYER:Order:order-1:R21_ORDER_CONFIRMED:event-1";
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ consent: "NOT_REQUIRED_FOR_SERVICE" } as never);
    prismaMock.communicationLog.findFirst.mockResolvedValue({ id: "wa-log-1" } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, role: "BUYER", category: "SERVICE", priority: "P1", taskEpisodeKey,
        data: delivery.notification.data },
    }] as never);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(prismaMock.communicationLog.findFirst).toHaveBeenCalledWith({
      where: {
        taskEpisodeKey, channel: "whatsapp", status: "DELIVERED",
        deliveredAt: { gte: new Date("2026-10-26T11:00:00.000Z"), lte: now },
      }, select: { id: true },
    });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("does not suppress on WhatsApp history when no approved cooldown is configured", async () => {
    const taskEpisodeKey = "buyer-1:BUYER:Order:order-1:R21_ORDER_CONFIRMED:event-1";
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ consent: "NOT_REQUIRED_FOR_SERVICE" } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, role: "BUYER", category: "SERVICE", priority: "P1", taskEpisodeKey,
        data: delivery.notification.data },
    }] as never);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-wa-window"] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(prismaMock.communicationLog.findFirst).not.toHaveBeenCalled();
    expect(sendPushToUser).toHaveBeenCalled();
  });

  it("does not suppress on unresolved WhatsApp provider outcomes", async () => {
    mockGetWhatsappCooldownSeconds.mockResolvedValue(3600);
    const taskEpisodeKey = "buyer-1:BUYER:Order:order-1:R21_ORDER_CONFIRMED:event-1";
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ consent: "NOT_REQUIRED_FOR_SERVICE" } as never);
    // QUEUED/SENT/FAILED records are not a positive delivery receipt.
    prismaMock.communicationLog.findFirst.mockResolvedValue(null);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, role: "BUYER", category: "SERVICE", priority: "P1", taskEpisodeKey,
        data: delivery.notification.data },
    }] as never);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-wa-unresolved"] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(prismaMock.communicationLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "DELIVERED",
        deliveredAt: { gte: new Date("2026-10-26T11:00:00.000Z"), lte: now },
      }),
    }));
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalled();
  });

  it("keeps critical transactional order messages independent of WhatsApp coordination", async () => {
    mockGetWhatsappCooldownSeconds.mockResolvedValue(3600);
    vi.stubEnv("R21_ORDER_CONFIRMED_ENABLED", "true");
    prismaMock.order.findUnique.mockResolvedValue({ buyerId: "buyer-1", status: "CONFIRMED" } as never);
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ consent: "NOT_REQUIRED_FOR_SERVICE" } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: {
        ...delivery.notification, role: "BUYER", category: "SERVICE", priority: "P1",
        taskEpisodeKey: "buyer-1:BUYER:Order:order-1:R21_ORDER_CONFIRMED:event-1",
        data: { type: "buyer_order_confirmed", ruleKey: "R21_ORDER_CONFIRMED", ruleVersion: 1, orderId: "order-1" },
      },
    }] as never);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-critical-service"] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(prismaMock.communicationLog.findFirst).not.toHaveBeenCalled();
    expect(sendPushToUser).toHaveBeenCalled();
  });

  it("rechecks latest explicit shipment delay and buyer ownership before R24 push", async () => {
    vi.stubEnv("R24_DELIVERY_EXCEPTION_ENABLED", "true");
    prismaMock.shipment.findUnique.mockResolvedValue({ id: "shipment-24", orderId: "order-24", status: "DELAYED" } as never);
    prismaMock.order.findUnique.mockResolvedValue({ buyerId: "buyer-1" } as never);
    prismaMock.event.findFirst.mockResolvedValue({ id: "event-24" } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, title: "Your delivery needs attention", body: "Review the available next steps.",
        data: { type: "shipment_delayed", ruleKey: "R24_DELIVERY_EXCEPTION", ruleVersion: 1, eventId: "event-24", orderId: "order-24", shipmentId: "shipment-24" } },
    }] as never);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-r24"] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-1", expect.objectContaining({ title: "Your delivery needs attention" }), { logId: "log-1" });
    vi.unstubAllEnvs();
  });

  it("cancels an R24 delay push when a newer shipment event supersedes it", async () => {
    vi.stubEnv("R24_DELIVERY_EXCEPTION_ENABLED", "true");
    prismaMock.shipment.findUnique.mockResolvedValue({ id: "shipment-24", orderId: "order-24", status: "DELAYED" } as never);
    prismaMock.order.findUnique.mockResolvedValue({ buyerId: "buyer-1" } as never);
    prismaMock.event.findFirst.mockResolvedValue({ id: "newer-event" } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, data: { type: "shipment_delayed", ruleKey: "R24_DELIVERY_EXCEPTION", ruleVersion: 1, eventId: "event-24", orderId: "order-24", shipmentId: "shipment-24" } },
    }] as never);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("rechecks the open unread support thread and retries when no device is registered", async () => {
    sendPushToUser.mockResolvedValue({ tokens: 0, accepted: 0, rejected: 0, ticketIds: [] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, retried: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-1", expect.objectContaining({ title: "Eki Support has replied" }), { logId: "log-1" });
    expect(txMock.communicationLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ channel: "push", eventKey: "notification_delivery:delivery-1:attempt:1" }),
    }));
    expect(prismaMock.notificationDelivery.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PENDING", lastError: "no_push_tokens", availableAt: new Date(now.getTime() + 30_000) }),
    }));
  });

  it("cancels at send time when the notification or message has already been read", async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{ ...delivery, notification: { ...delivery.notification, readAt: now } }]);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(txMock.communicationLog.create).not.toHaveBeenCalled();
  });

  it("records provider receipt success against the delivery outcome", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "delivery-1", attempt: 1, status: "SENT" });
    await notificationDeliveryService.recordReceipt("log-1", true, "receipt_ok");
    expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "delivery-1", status: "SENT" },
      data: expect.objectContaining({ status: "DELIVERED", lastError: null }),
    });
  });

  it("rechecks R25 payout ownership and ON_HOLD state before push", async () => {
    vi.stubEnv("R25_PAYOUT_ACTION_REQUIRED_ENABLED", "true");
    prismaMock.payoutRequest.findUnique.mockResolvedValue({ status: "ON_HOLD", vendor: { userId: "vendor-1" } } as never);
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: {
        ...delivery.notification, userId: "vendor-1", title: "Your payout needs attention",
        body: "Review the secure payment-provider requirement.",
        data: { type: "payout_action_required", ruleKey: "R25_PAYOUT_ACTION_REQUIRED", ruleVersion: 1, payoutRequestId: "payout-1", destination: "membership" },
      },
    }] as never);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-r25"] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("vendor-1", expect.objectContaining({ title: "Your payout needs attention" }), { logId: "log-1" });
    vi.unstubAllEnvs();
  });

  it("rechecks R26 PAID state and vendor ownership before push", async () => {
    vi.stubEnv("R26_PAYOUT_CONFIRMED_ENABLED", "true");
    prismaMock.payoutRequest.findUnique.mockResolvedValue({ status: "PAID", vendor: { userId: "vendor-1" } } as never);
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: {
        ...delivery.notification, userId: "vendor-1", title: "Your payout has been completed", body: "View the transaction details.",
        data: { type: "payout_confirmed", ruleKey: "R26_PAYOUT_CONFIRMED", ruleVersion: 1, payoutRequestId: "payout-2", destination: "membership" },
      },
    }] as never);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-r26"] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("vendor-1", expect.objectContaining({ title: "Your payout has been completed" }), { logId: "log-1" });
    vi.unstubAllEnvs();
  });

  it("cancels R25 after payout resolution", async () => {
    vi.stubEnv("R25_PAYOUT_ACTION_REQUIRED_ENABLED", "true");
    prismaMock.payoutRequest.findUnique.mockResolvedValue({ status: "PAID", vendor: { userId: "vendor-1" } } as never);
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false } as never);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, userId: "vendor-1", data: { type: "payout_action_required", ruleKey: "R25_PAYOUT_ACTION_REQUIRED", ruleVersion: 1, payoutRequestId: "payout-1" } },
    }] as never);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("rechecks vendor ownership and stock episode before sending R17", async () => {
    vi.stubEnv("R17_STOCK_DEPLETED_ENABLED", "true");
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: {
        ...delivery.notification, userId: "vendor-1", title: "Rice is out of stock", body: "Restock it when available.",
        data: { type: "product_stock_depleted", ruleKey: "R17_STOCK_DEPLETED", ruleVersion: 1, productId: "product-1", stockVersion: 4, destination: "inventory_detail" },
      },
    }]);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-1"] });
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("vendor-1", expect.objectContaining({ title: "Rice is out of stock" }), { logId: "log-1" });
    vi.unstubAllEnvs();
  });

  it("cancels R17 when the stock episode changed before provider delivery", async () => {
    vi.stubEnv("R17_STOCK_DEPLETED_ENABLED", "true");
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });
    prismaMock.product.findUnique.mockResolvedValue({
      id: "product-1", vendor: { userId: "vendor-1" }, isActive: true, status: "PUBLISHED", stock: 0, stockVersion: 5,
    });
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: { ...delivery.notification, userId: "vendor-1", data: { type: "product_stock_depleted", ruleKey: "R17_STOCK_DEPLETED", ruleVersion: 1, productId: "product-1", stockVersion: 4 } },
    }]);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("cancels R35 if the campaign closes before the scheduled send", async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: {
        ...delivery.notification,
        title: "Your Community Buy reached its minimum",
        body: "Review the campaign's next step.",
        data: {
          type: "community_campaign_update", event: "minimum_reached", ruleKey: "R35_COMMUNITY_BUY_MINIMUM_REACHED",
          ruleVersion: 1, campaignId: "campaign-1", confirmedShares: 6, minimumShares: 5,
        },
      },
    }] as never);
    prismaMock.communityCampaign.findUnique.mockResolvedValue({
      status: "CANCELLED", minimumShares: 5, confirmedShares: 6, organiser: { userId: "buyer-1" },
    } as never);

    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("keeps an authorisation-mode R35 notice eligible through successful capture into fulfilment", async () => {
    vi.stubEnv("R35_COMMUNITY_BUY_MINIMUM_REACHED_ENABLED", "true");
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: {
        ...delivery.notification,
        title: "Your Community Buy reached its minimum",
        body: "Review the campaign's next step.",
        data: {
          type: "community_campaign_update", event: "minimum_reached", ruleKey: "R35_COMMUNITY_BUY_MINIMUM_REACHED",
          ruleVersion: 1, campaignId: "campaign-1", confirmedShares: 5, minimumShares: 5,
        },
      },
    }] as never);
    prismaMock.communityCampaign.findUnique.mockResolvedValue({
      status: "FULFILLING", paymentMode: "AUTHORISE_THEN_CAPTURE", minimumShares: 5, confirmedShares: 0,
      organiser: { userId: "buyer-1" },
    } as never);
    sendPushToUser.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["ticket-r35"] });

    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendPushToUser).toHaveBeenCalledWith("buyer-1", expect.objectContaining({
      title: "Your Community Buy reached its minimum",
    }), { logId: "log-1" });
  });

  it("requeues a failed provider receipt with backoff unless the attempt limit is reached", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "delivery-1", attempt: 2, status: "SENT" });
    await notificationDeliveryService.recordReceipt("log-1", false, "DeviceNotRegistered");
    expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "delivery-1", status: "SENT" },
      data: expect.objectContaining({ status: "PENDING", lastError: "DeviceNotRegistered" }),
    });
  });
});

