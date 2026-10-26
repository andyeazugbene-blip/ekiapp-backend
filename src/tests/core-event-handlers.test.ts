import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCandidate } = vi.hoisted(() => ({ createCandidate: vi.fn() }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { create: createCandidate } }));
vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { handleSupportResponseReceived } from "../modules/events/core-event-handlers";

const supportMessage = {
  id: "message-1",
  conversationId: "conversation-1",
  senderId: "admin-1",
  isInternal: false,
  readAt: null,
  conversation: {
    id: "conversation-1", type: "SUPPORT", status: "OPEN",
    participantA: "admin-1", participantB: "buyer-1",
  },
};

function makeTx(message = supportMessage, roles = new Map([["admin-1", "ADMIN"], ["buyer-1", "BUYER"]])) {
  return {
    message: { findUnique: vi.fn().mockResolvedValue(message) },
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const role = roles.get(where.id);
      return role ? { id: where.id, role } : null;
    }) },
  } as never;
}

const outboxEvent = {
  payload: { conversationId: "conversation-1", messageId: "message-1" },
} as never;

beforeEach(() => vi.clearAllMocks());

describe("R28 general support response outbox handler", () => {
  it("creates the exact, recipient-targeted idempotent inbox candidate", async () => {
    createCandidate.mockResolvedValue({ id: "notification-1" });
    const tx = {
      ...(makeTx() as object),
      notification: { findUnique: vi.fn() },
      notificationDelivery: { upsert: vi.fn() },
    } as never;
    await handleSupportResponseReceived(tx, outboxEvent);
    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "buyer-1",
      title: "Eki Support has replied",
      body: "Open your case to read the update.",
      dedupeKey: "R28_SUPPORT_THREAD_REPLY:message-1",
      data: expect.objectContaining({ destination: "support_conversation", conversationId: "conversation-1", messageId: "message-1" }),
    }), tx);
    expect((tx as any).notificationDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { notificationId_channel: { notificationId: "notification-1", channel: "push" } },
    }));
  });

  it.each([
    ["closed thread", { ...supportMessage, conversation: { ...supportMessage.conversation, status: "CLOSED" } }],
    ["already read reply", { ...supportMessage, readAt: new Date() }],
    ["internal note", { ...supportMessage, isInternal: true }],
    ["non-support thread", { ...supportMessage, conversation: { ...supportMessage.conversation, type: "BUYER_VENDOR" } }],
  ])("does not create a candidate for a %s", async (_label, message) => {
    await handleSupportResponseReceived(makeTx(message), outboxEvent);
    expect(createCandidate).not.toHaveBeenCalled();
  });
});

