import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    pushToken: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { pushTokensService } from "../modules/push-tokens/push-tokens.service";
import { sendExpoPush, sendPushToUser } from "../lib/expo-push";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("pushTokensService.register — real Expo token format validation (architecture doc §5 requirement #6)", () => {
  it("accepts a genuine ExponentPushToken", async () => {
    m.pushToken.upsert.mockResolvedValue({ id: "pt-1", userId: "u1", token: "ExponentPushToken[abc123]", platform: "android", createdAt: new Date() });
    const result = await pushTokensService.register("u1", "ExponentPushToken[abc123]", "android");
    expect(result.token).toBe("ExponentPushToken[abc123]");
  });

  it("accepts the alternate ExpoPushToken format", async () => {
    m.pushToken.upsert.mockResolvedValue({ id: "pt-2", userId: "u1", token: "ExpoPushToken[xyz789]", platform: "ios", createdAt: new Date() });
    const result = await pushTokensService.register("u1", "ExpoPushToken[xyz789]", "ios");
    expect(result.token).toBe("ExpoPushToken[xyz789]");
  });

  it("rejects a garbage/non-Expo token — e.g. a raw FCM token, which this architecture never stores directly", async () => {
    await expect(pushTokensService.register("u1", "fcm-raw-device-token-abc", "android")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.pushToken.upsert).not.toHaveBeenCalled();
  });

  it("re-registering the same token for the same user upserts, not duplicates", async () => {
    m.pushToken.upsert.mockResolvedValue({ id: "pt-1", userId: "u1", token: "ExponentPushToken[abc123]", platform: "android", createdAt: new Date() });
    await pushTokensService.register("u1", "ExponentPushToken[abc123]", "android");
    expect(m.pushToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_token: { userId: "u1", token: "ExponentPushToken[abc123]" } } }),
    );
  });
});

describe("pushTokensService.remove", () => {
  it("404s when the token doesn't belong to (or doesn't exist for) this user", async () => {
    m.pushToken.deleteMany.mockResolvedValue({ count: 0 });
    await expect(pushTokensService.remove("u1", "ExponentPushToken[gone]")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("succeeds when a matching token is removed", async () => {
    m.pushToken.deleteMany.mockResolvedValue({ count: 1 });
    await expect(pushTokensService.remove("u1", "ExponentPushToken[abc123]")).resolves.toBeUndefined();
  });
});

describe("sendExpoPush — the actual relay to Expo's push API (architecture doc §8: Expo → FCM → device)", () => {
  it("posts the message batch to the real Expo push endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: "ok", id: "ticket-1" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://exp.host/--/api/v2/push/send",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("removes a push token from the DB when Expo reports DeviceNotRegistered — this is how a stale/uninstalled-app token gets cleaned up", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    m.pushToken.deleteMany.mockResolvedValue({ count: 1 });

    await sendExpoPush([{ to: "ExponentPushToken[stale]", title: "Hi", body: "There" }]);

    expect(m.pushToken.deleteMany).toHaveBeenCalledWith({ where: { token: "ExponentPushToken[stale]" } });
  });

  it("never throws when Expo's API is unreachable — push failures must not break the calling operation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }])).resolves.toBeUndefined();
  });

  it("never throws when Expo's API returns a non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "server error" }));
    await expect(sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }])).resolves.toBeUndefined();
  });
});

describe("sendPushToUser — real event-to-device routing", () => {
  it("sends to every registered device for a user, with the right Android channel mapped from the notification type", async () => {
    m.pushToken.findMany.mockResolvedValue([{ token: "ExponentPushToken[dev1]" }, { token: "ExponentPushToken[dev2]" }]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: "ok" }, { status: "ok" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await sendPushToUser("buyer-1", { title: "New Order! 🛒", body: "...", data: { type: "new_order", orderId: "ord-1" } });

    const [, options] = fetchMock.mock.calls[0];
    const sentMessages = JSON.parse(options.body as string);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].channelId).toBe("orders");
  });

  it("skips sending entirely (no Expo API call) when the user has no registered devices", async () => {
    m.pushToken.findMany.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await sendPushToUser("buyer-no-devices", { title: "Hi", body: "There" });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
