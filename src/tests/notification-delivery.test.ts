import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, sendPushToUser } = vi.hoisted(() => {
  const txMock = {
    communicationLog: { create: vi.fn() },
    notificationDelivery: { updateMany: vi.fn() },
  };
  return {
    txMock,
    sendPushToUser: vi.fn(),
    prismaMock: {
      notificationDelivery: { updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
      message: { findUnique: vi.fn() },
      product: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
      communicationLog: { update: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    },
  };
});

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../lib/expo-push", () => ({ sendPushToUser }));

import { notificationDeliveryService } from "../modules/notifications/notification-delivery.service";

const now = new Date("2026-10-26T12:00:00.000Z");
const delivery = {
  id: "delivery-1", attempt: 0, status: "PENDING", channel: "push",
  notification: {
    id: "notification-1", userId: "buyer-1", title: "Eki Support has replied",
    body: "Open your case to read the update.", readAt: null,
    data: { type: "support_case_response", destination: "support_case", conversationId: "conversation-1", messageId: "message-1" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe("notification push delivery", () => {
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

  it("rechecks vendor ownership and stock episode before sending R17", async () => {
    vi.stubEnv("R17_STOCK_DEPLETED_ENABLED", "true");
    prismaMock.user.findUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isSuspended: false });
    prismaMock.notificationDelivery.findMany.mockResolvedValue([{
      ...delivery,
      notification: {
        ...delivery.notification, userId: "vendor-1", title: "Rice is out of stock", body: "Restock it when available.",
        data: { type: "product_stock_depleted", productId: "product-1", stockVersion: 4, destination: "inventory_detail" },
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
      notification: { ...delivery.notification, userId: "vendor-1", data: { type: "product_stock_depleted", productId: "product-1", stockVersion: 4 } },
    }]);
    const result = await notificationDeliveryService.dispatchBatch(10, now);
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(sendPushToUser).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
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

