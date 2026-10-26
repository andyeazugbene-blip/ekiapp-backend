import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCandidate } = vi.hoisted(() => ({ createCandidate: vi.fn() }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { create: createCandidate } }));
vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { handleCommunityBuyMinimumReached, handlePayoutActionRequired, handlePayoutConfirmed, handleProductStockDepleted, handleSupportResponseReceived } from "../modules/events/core-event-handlers";

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
  id: "event-r28",
  name: "support_response_received",
  schemaVersion: 1,
  payload: { conversationId: "conversation-1", messageId: "message-1" },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("R28_GENERAL_SUPPORT_NOTIFICATIONS_ENABLED", "true");
});

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
      data: expect.objectContaining({ type: "support_case_response", ruleKey: "R28_SUPPORT_RESPONSE", ruleVersion: 1, eventId: "event-r28", destination: "support_case", conversationId: "conversation-1", messageId: "message-1" }),
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

describe("R25 payout action-required outbox handler", () => {
  it("creates the exact candidate only for the vendor while their payout remains ON_HOLD", async () => {
    vi.stubEnv("R25_PAYOUT_ACTION_REQUIRED_ENABLED", "true");
    createCandidate.mockResolvedValue({ id: "notification-r25" });
    const tx = {
      payoutRequest: { findUnique: vi.fn().mockResolvedValue({ id: "payout-1", vendorId: "vendor-1", status: "ON_HOLD", vendor: { userId: "vendor-user" } }) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "vendor-user", role: "VENDOR", isSuspended: false }) },
      notification: { findUnique: vi.fn() },
      notificationDelivery: { upsert: vi.fn() },
    } as never;
    await handlePayoutActionRequired(tx, { id: "event-r25", name: "payout_action_required", schemaVersion: 1, payload: { payoutRequestId: "payout-1" } } as never);
    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "vendor-user",
      title: "Your payout needs attention",
      body: "Review the secure payment-provider requirement.",
      dedupeKey: "R25_PAYOUT_ACTION_REQUIRED:payout-1",
      data: expect.objectContaining({ ruleKey: "R25_PAYOUT_ACTION_REQUIRED", destination: "membership", payoutRequestId: "payout-1" }),
    }), tx);
  });

  it("remains disabled by default", async () => {
    vi.stubEnv("R25_PAYOUT_ACTION_REQUIRED_ENABLED", "false");
    await handlePayoutActionRequired({} as never, { name: "payout_action_required", schemaVersion: 1 } as never);
    expect(createCandidate).not.toHaveBeenCalled();
  });
});

describe("R26 payout confirmed outbox handler", () => {
  it("creates the exact candidate for the owning vendor after PAID", async () => {
    vi.stubEnv("R26_PAYOUT_CONFIRMED_ENABLED", "true");
    createCandidate.mockResolvedValue({ id: "notification-r26" });
    const tx = {
      payoutRequest: { findUnique: vi.fn().mockResolvedValue({ id: "payout-2", status: "PAID", vendor: { userId: "vendor-user" } }) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "vendor-user", role: "VENDOR", isSuspended: false }) },
      notification: { findUnique: vi.fn() },
      notificationDelivery: { upsert: vi.fn() },
    } as never;
    await handlePayoutConfirmed(tx, { id: "event-r26", name: "payout_confirmed", schemaVersion: 1, payload: { payoutRequestId: "payout-2" } } as never);
    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "vendor-user", title: "Your payout has been completed", body: "View the transaction details.",
      dedupeKey: "R26_PAYOUT_CONFIRMED:payout-2",
      data: expect.objectContaining({ ruleKey: "R26_PAYOUT_CONFIRMED", destination: "membership", payoutRequestId: "payout-2" }),
    }), tx);
  });

  it("does not create a candidate while the rule gate is off", async () => {
    vi.stubEnv("R26_PAYOUT_CONFIRMED_ENABLED", "false");
    await handlePayoutConfirmed({} as never, { name: "payout_confirmed", schemaVersion: 1 } as never);
    expect(createCandidate).not.toHaveBeenCalled();
  });
});

describe("R17 stock-depleted outbox handler", () => {
  const product = { id: "product-1", title: "Rice", stock: 0, stockVersion: 4, isActive: true, status: "PUBLISHED", vendor: { userId: "vendor-user" } };
  const tx = {
    product: { findUnique: vi.fn().mockResolvedValue(product) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "vendor-user", role: "VENDOR", isSuspended: false }) },
    notification: { findUnique: vi.fn() },
    notificationDelivery: { upsert: vi.fn() },
  } as never;
  const event = { id: "event-r17", name: "product_stock_depleted", schemaVersion: 1, payload: { productId: "product-1", stockVersion: 4 } } as never;

  it("keeps R17 disabled unless its explicit reviewed gate is enabled", async () => {
    vi.stubEnv("R17_STOCK_DEPLETED_ENABLED", "false");
    await handleProductStockDepleted(tx, event);
    expect(createCandidate).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("creates the exact vendor notification for the still-current zero-stock episode", async () => {
    vi.stubEnv("R17_STOCK_DEPLETED_ENABLED", "true");
    createCandidate.mockResolvedValue({ id: "notification-r17" });
    await handleProductStockDepleted(tx, event);
    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "vendor-user", title: "Rice is out of stock", body: "Restock it when available.",
      dedupeKey: "R17_STOCK_DEPLETED:product-1:v4",
      data: expect.objectContaining({ ruleKey: "R17_STOCK_DEPLETED", ruleVersion: 1, eventId: "event-r17", destination: "inventory_detail", productId: "product-1", stockVersion: 4 }),
    }), tx);
    expect((tx as any).notificationDelivery.upsert).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("suppresses an old episode after stock changes or the listing is unavailable", async () => {
    vi.stubEnv("R17_STOCK_DEPLETED_ENABLED", "true");
    const staleTx = { ...(tx as object), product: { findUnique: vi.fn().mockResolvedValue({ ...product, stockVersion: 5 }) } } as never;
    await handleProductStockDepleted(staleTx, event);
    expect(createCandidate).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("R35 Community Buy minimum-reached outbox handler", () => {
  it("creates one exact organiser candidate from confirmed minimum state", async () => {
    createCandidate.mockResolvedValue({ id: "notification-r35" });
    const tx = {
      communityCampaign: { findUnique: vi.fn().mockResolvedValue({
        id: "campaign-1", title: "Rice", status: "LIVE", minimumShares: 5, confirmedShares: 6,
        organiser: { userId: "organiser-1" },
      }) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "organiser-1", role: "BUYER", isSuspended: false }) },
      notification: { findUnique: vi.fn() },
      notificationDelivery: { upsert: vi.fn() },
    } as never;
    const event = {
      id: "event-r35", name: "community_buy_minimum_reached", schemaVersion: 1,
      payload: { campaignId: "campaign-1", confirmedShares: 6, minimumShares: 5 },
    } as never;

    await handleCommunityBuyMinimumReached(tx, event);

    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "organiser-1",
      title: "Your Community Buy reached its minimum",
      body: "Review the campaign's next step.",
      dedupeKey: "R35_COMMUNITY_BUY_MINIMUM_REACHED:campaign-1",
      data: expect.objectContaining({
        ruleKey: "R35_COMMUNITY_BUY_MINIMUM_REACHED", ruleVersion: 1, eventId: "event-r35",
        destination: "community_buy_campaign", audience: "organiser", campaignId: "campaign-1", confirmedShares: 6, minimumShares: 5,
      }),
    }), tx);
    expect((tx as any).notificationDelivery.upsert).toHaveBeenCalled();
  });

  it("suppresses a threshold event if the minimum changed or the campaign closed", async () => {
    const event = {
      id: "event-r35", name: "community_buy_minimum_reached", schemaVersion: 1,
      payload: { campaignId: "campaign-1", confirmedShares: 6, minimumShares: 5 },
    } as never;
    const tx = {
      communityCampaign: { findUnique: vi.fn().mockResolvedValue({
        id: "campaign-1", status: "CANCELLED", minimumShares: 7, confirmedShares: 6, organiser: { userId: "organiser-1" },
      }) },
      user: { findUnique: vi.fn() }, notification: { findUnique: vi.fn() }, notificationDelivery: { upsert: vi.fn() },
    } as never;
    await handleCommunityBuyMinimumReached(tx, event);
    expect(createCandidate).not.toHaveBeenCalled();
  });
});

