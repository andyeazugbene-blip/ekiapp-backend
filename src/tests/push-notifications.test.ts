import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    pushToken: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    pushTicket: { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { pushTokensService } from "../modules/push-tokens/push-tokens.service";
import { sendExpoPush, sendPushToUser, checkPushReceipts } from "../lib/expo-push";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  m.pushTicket.createMany.mockResolvedValue({ count: 0 } as never);
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
      expect.objectContaining({ where: { token: "ExponentPushToken[abc123]" } }),
    );
  });

  it("re-registering the SAME token under a DIFFERENT user reassigns it, rather than creating a stale second row — a device only belongs to whoever is currently signed into it", async () => {
    m.pushToken.upsert.mockResolvedValue({ id: "pt-1", userId: "u2", token: "ExponentPushToken[shared-device]", platform: "ios", createdAt: new Date() });
    await pushTokensService.register("u2", "ExponentPushToken[shared-device]", "ios");
    expect(m.pushToken.upsert).toHaveBeenCalledWith({
      where: { token: "ExponentPushToken[shared-device]" },
      update: { userId: "u2", platform: "ios" },
      create: { userId: "u2", token: "ExponentPushToken[shared-device]", platform: "ios" },
    });
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
});

/**
 * Regression coverage for the "Expo dashboard shows no data" investigation:
 * every send/receipt call went out with no Authorization header at all.
 * Expo's push API still accepts and delivers unauthenticated requests (the
 * token itself is what ties a request to a project), but Expo's own docs
 * describe the access-token header as how a send gets attributed to a
 * specific expo.dev account/project for dashboard analytics — its absence
 * is the most likely explanation for the dashboard showing nothing despite
 * real sends succeeding. This is optional and backward compatible: with no
 * EXPO_ACCESS_TOKEN configured, behavior is byte-for-byte unchanged.
 */
describe("sendExpoPush / checkPushReceipts — optional Expo access token", () => {
  const ORIGINAL_ENV = process.env.EXPO_ACCESS_TOKEN;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.EXPO_ACCESS_TOKEN;
    else process.env.EXPO_ACCESS_TOKEN = ORIGINAL_ENV;
  });

  it("sends with no Authorization header when EXPO_ACCESS_TOKEN is not set (current production behavior, unchanged)", async () => {
    delete process.env.EXPO_ACCESS_TOKEN;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: "ok", id: "t1" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }]);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("includes a Bearer Authorization header when EXPO_ACCESS_TOKEN is configured", async () => {
    process.env.EXPO_ACCESS_TOKEN = "test-expo-access-token";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: "ok", id: "t1" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }]);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer test-expo-access-token");
  });

  it("also authenticates the receipts call the same way", async () => {
    process.env.EXPO_ACCESS_TOKEN = "test-expo-access-token";
    m.pushTicket.findMany.mockResolvedValue([{ id: "row-1", ticketId: "t1", token: "ExponentPushToken[abc123]", userId: "u1", createdAt: new Date(0) }] as never);
    m.pushTicket.deleteMany.mockResolvedValue({ count: 1 } as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);

    await checkPushReceipts();

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer test-expo-access-token");
  });

  it("never throws when Expo's API returns a non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "server error" }));
    await expect(sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }])).resolves.toBeUndefined();
  });

  it("persists an accepted ticket for a later real receipt check — a ticket status of 'ok' is only Expo's queue-acceptance, not proof of APNs/FCM delivery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: "ok", id: "ticket-xyz" }] }) }));

    await sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }], [{ userId: "buyer-1" }]);

    expect(m.pushTicket.createMany).toHaveBeenCalledWith({
      data: [{ ticketId: "ticket-xyz", token: "ExponentPushToken[abc123]", userId: "buyer-1" }],
      skipDuplicates: true,
    });
  });

  it("does not persist a ticket when no userId context is given (nothing to check receipts against)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: "ok", id: "ticket-xyz" }] }) }));

    await sendExpoPush([{ to: "ExponentPushToken[abc123]", title: "Hi", body: "There" }]);

    expect(m.pushTicket.createMany).not.toHaveBeenCalled();
  });
});

describe("checkPushReceipts — the real proof of delivery a ticket alone can never give", () => {
  it("does nothing (no Expo API call) when no tickets are old enough to check yet", async () => {
    m.pushTicket.findMany.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkPushReceipts();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, invalidated: 0, errors: 0 });
  });

  it("removes the push token when the REAL receipt (not the ticket) reports DeviceNotRegistered", async () => {
    m.pushTicket.findMany.mockResolvedValue([
      { id: "pt-1", ticketId: "ticket-1", token: "ExponentPushToken[stale]", userId: "buyer-1", createdAt: new Date() },
    ] as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { "ticket-1": { status: "error", details: { error: "DeviceNotRegistered" } } } }),
    }));
    m.pushToken.deleteMany.mockResolvedValue({ count: 1 } as never);

    const result = await checkPushReceipts();

    expect(m.pushToken.deleteMany).toHaveBeenCalledWith({ where: { token: "ExponentPushToken[stale]" } });
    expect(result).toEqual({ checked: 1, invalidated: 1, errors: 0 });
    // The checked ticket is always cleaned up, regardless of outcome.
    expect(m.pushTicket.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["pt-1"] } } });
  });

  it("classifies a real APNs/FCM-level failure (e.g. bad credentials) instead of silently discarding it — this is exactly what a ticket-only check can never surface", async () => {
    m.pushTicket.findMany.mockResolvedValue([
      { id: "pt-2", ticketId: "ticket-2", token: "ExponentPushToken[abc]", userId: "buyer-2", createdAt: new Date() },
    ] as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { "ticket-2": { status: "error", details: { error: "InvalidCredentials" } } } }),
    }));

    const result = await checkPushReceipts();

    expect(m.pushToken.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, invalidated: 0, errors: 1 });
  });

  it("does not remove a token or count an error for a genuinely successful receipt", async () => {
    m.pushTicket.findMany.mockResolvedValue([
      { id: "pt-3", ticketId: "ticket-3", token: "ExponentPushToken[good]", userId: "buyer-3", createdAt: new Date() },
    ] as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { "ticket-3": { status: "ok" } } }),
    }));

    const result = await checkPushReceipts();

    expect(m.pushToken.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, invalidated: 0, errors: 0 });
  });

  it("never throws when Expo's receipts API is unreachable, and still cleans up the pending tickets", async () => {
    m.pushTicket.findMany.mockResolvedValue([
      { id: "pt-4", ticketId: "ticket-4", token: "ExponentPushToken[x]", userId: "buyer-4", createdAt: new Date() },
    ] as never);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(checkPushReceipts()).resolves.toEqual({ checked: 1, invalidated: 0, errors: 0 });
    expect(m.pushTicket.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["pt-4"] } } });
  });
});

describe("sendPushToUser — real event-to-device routing", () => {
  it("sends one Expo request PER registered device, not one batched request for all of a user's devices, with the right Android channel mapped from the notification type", async () => {
    m.pushToken.findMany.mockResolvedValue([{ token: "ExponentPushToken[dev1]" }, { token: "ExponentPushToken[dev2]" }]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: "ok" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await sendPushToUser("buyer-1", { title: "New Order! 🛒", body: "...", data: { type: "new_order", orderId: "ord-1" } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body as string));
    expect(bodies.every((b) => b.length === 1)).toBe(true);
    expect(bodies.map((b) => b[0].to).sort()).toEqual(["ExponentPushToken[dev1]", "ExponentPushToken[dev2]"]);
    expect(bodies[0][0].channelId).toBe("orders");
  });

  it("a stale/orphaned token from a retired Expo project cannot block delivery to the user's other, valid token — real bug: Expo rejects an ENTIRE batched request with PUSH_TOO_MANY_EXPERIENCE_IDS when it mixes tokens from more than one Expo project, which happens whenever a user has tokens registered under this app's old and current EAS project ownership (this app's EAS project ownership has genuinely changed multiple times)", async () => {
    m.pushToken.findMany.mockResolvedValue([
      { token: "ExponentPushToken[stale-old-project]" },
      { token: "ExponentPushToken[valid-current-project]" },
    ]);
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      const [message] = JSON.parse(options.body as string);
      if (message.to === "ExponentPushToken[stale-old-project]") {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] }),
        };
      }
      return { ok: true, json: async () => ({ data: [{ status: "ok", id: "ticket-valid" }] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendPushToUser("buyer-mixed-projects", { title: "Hi", body: "There" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The valid token's own request must have gone out and succeeded independently —
    // isolating per-token means the stale token's failure never reaches it.
    const validCall = fetchMock.mock.calls.find(([, options]) => (JSON.parse(options.body as string))[0].to === "ExponentPushToken[valid-current-project]");
    expect(validCall).toBeDefined();
  });

  it("skips sending entirely (no Expo API call) when the user has no registered devices", async () => {
    m.pushToken.findMany.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await sendPushToUser("buyer-no-devices", { title: "Hi", body: "There" });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
