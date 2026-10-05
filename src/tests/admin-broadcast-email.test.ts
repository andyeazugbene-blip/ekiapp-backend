/**
 * Communication Center broadcast engine (handbook 6.2 / 6.3):
 * input validation (no SMS, deep-link allow-list, template variables),
 * channel-status truth, eligible/excluded counts with reasons, gating
 * (consent, push token, quiet hours, frequency cap, automation conflict),
 * idempotency, emergency pause, mandatory test-send proof, email
 * "not configured" honesty, per-recipient CommunicationLog + status counts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  broadcasts: new Map<string, any>(),
  logs: [] as any[],
  seq: 0,
  paused: 0,
}));

vi.mock("../lib/prisma", () => {
  const prisma: any = {
    user: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn().mockResolvedValue(10) },
    order: { groupBy: vi.fn(), findMany: vi.fn() },
    pushToken: { findMany: vi.fn().mockResolvedValue([]) },
    automationRun: { findMany: vi.fn().mockResolvedValue([]) },
    notification: { create: vi.fn().mockResolvedValue({}), count: vi.fn().mockResolvedValue(0) },
    conversation: { upsert: vi.fn().mockResolvedValue({ id: "conv-1" }) },
    message: { create: vi.fn().mockResolvedValue({}) },
    adminPlatformSetting: {
      findMany: vi.fn(async () => [{ key: "commsPaused", value: store.paused, updatedAt: new Date(), updatedById: null }]),
    },
    communicationLog: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(async ({ data }: any) => { store.logs.push(...data.map((d: any) => ({ ...d }))); return { count: data.length }; }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.logs.find((l) => l.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      groupBy: vi.fn(async () => {
        const groups = new Map<string, any>();
        for (const l of store.logs) {
          const key = `${l.broadcastId}|${l.channel}|${l.status}`;
          const g = groups.get(key) ?? { broadcastId: l.broadcastId, channel: l.channel, status: l.status, _count: { id: 0 } };
          g._count.id += 1;
          groups.set(key, g);
        }
        return [...groups.values()];
      }),
    },
    broadcast: {
      create: vi.fn(async ({ data }: any) => {
        if (data.idempotencyKey && [...store.broadcasts.values()].some((b) => b.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: `b${++store.seq}`, audienceTotal: 0, error: null, completedAt: null, ...data };
        store.broadcasts.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        where.id ? store.broadcasts.get(where.id) ?? null : [...store.broadcasts.values()].find((b) => b.idempotencyKey === where.idempotencyKey) ?? null),
      update: vi.fn(async ({ where, data }: any) => Object.assign(store.broadcasts.get(where.id), data)),
    },
  };
  return { prisma };
});

vi.mock("../lib/expo-push", () => ({
  sendPushToUser: vi.fn(),
  checkPushReceipts: vi.fn().mockResolvedValue({ checked: 0, invalidated: 0, errors: 0 }),
}));
vi.mock("../lib/email", () => ({ isEmailEnabled: vi.fn(), sendEmailDetailed: vi.fn() }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ isQuietHoursNow: vi.fn().mockReturnValue(false) }));

import { prisma } from "../lib/prisma";
import { sendPushToUser } from "../lib/expo-push";
import { isEmailEnabled, sendEmailDetailed } from "../lib/email";
import { isQuietHoursNow } from "../modules/automation/automation.service";
import { resetPauseCache } from "../modules/communications/comms-pause.service";
import { adminCommunicationsService } from "../modules/admin/admin-communications.service";

const m = vi.mocked(prisma, true) as any;
const push = vi.mocked(sendPushToUser);
const emailOn = vi.mocked(isEmailEnabled);
const sendMail = vi.mocked(sendEmailDetailed);
const quiet = vi.mocked(isQuietHoursNow);

const ACTOR = "admin-1";
const NOW = new Date();

function recipient(over: Record<string, unknown> = {}) {
  return {
    id: "buyer-1", role: "BUYER", name: "Amara", phone: null, email: "buyer1@example.com",
    isSuspended: false, anonymisedAt: null, marketingConsentAt: NOW, vendor: null, ...over,
  };
}

function input(over: Record<string, unknown> = {}) {
  return adminCommunicationsService.normalizeInput({
    audience: "buyers", channels: ["in_app", "push", "email"], subject: "Sale {{name}}", body: "20% off", category: "marketing", ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.broadcasts.clear();
  store.logs.length = 0;
  store.seq = 0;
  store.paused = 0;
  resetPauseCache();
  quiet.mockReturnValue(false);
  emailOn.mockReturnValue(true);
  sendMail.mockResolvedValue({ ok: true, id: "msg-1" });
  push.mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: ["tk-1"] });
  m.user.findMany.mockResolvedValue([recipient()]);
  m.pushToken.findMany.mockResolvedValue([{ userId: "buyer-1" }]);
  m.automationRun.findMany.mockResolvedValue([]);
  m.communicationLog.findMany.mockResolvedValue([]);
});

describe("normalizeInput", () => {
  it("rejects SMS outright (no SMS channel)", () => {
    expect(() => input({ channels: ["sms"] })).toThrow(/sms is not available/i);
  });

  it("legacy combo strings drop their SMS part instead of sending SMS", () => {
    const i = adminCommunicationsService.normalizeInput({ audience: "buyers", channel: "in_app_push_sms", subject: "Hi", body: "B" });
    expect(i).toMatchObject({ wantsInApp: true, wantsPush: true, wantsEmail: false });
    expect(i).not.toHaveProperty("wantsSms");
  });

  it("requires at least one channel", () => {
    expect(() => input({ channels: [] })).toThrow(/at least one delivery channel/i);
  });

  it("validates the deep link against the app-route allow-list", () => {
    expect(input({ deepLink: "/(buyer)/deals" }).deepLink).toBe("/(buyer)/deals");
    expect(() => input({ deepLink: "https://evil.example" })).toThrow(/supported app routes/i);
    expect(() => input({ deepLink: "/(buyer)/deals?x=<script>" })).toThrow();
  });

  it("rejects template variables a broadcast cannot fill", () => {
    expect(() => input({ body: "Order {{order_number}}" })).toThrow(/unsupported template variable/i);
  });

  it("individual audiences default to the operational category, groups to marketing", () => {
    expect(input({ audience: "individual_user", userId: "u1", category: undefined }).category).toBe("operational");
    expect(input({ category: undefined }).category).toBe("marketing");
  });
});

describe("channelStatus", () => {
  it("reports email as NOT configured when the provider is missing, SMS unavailable, push coverage real", async () => {
    emailOn.mockReturnValue(false);
    m.user.count.mockResolvedValue(4);
    m.pushToken.findMany.mockResolvedValue([{ userId: "a" }]);
    const s = await adminCommunicationsService.channelStatus();
    expect(s.email.configured).toBe(false);
    expect(s.sms.available).toBe(false);
    expect(s.in_app.configured).toBe(true);
    expect(s.push).toMatchObject({ tokenUsers: 1, totalUsers: 4, coveragePct: 25 });
  });
});

describe("previewAudience — exact eligible/excluded counts with reasons", () => {
  it("counts exclusions per channel with the real reason", async () => {
    m.user.findMany.mockResolvedValue([
      recipient({ id: "ok" }),
      recipient({ id: "nocons", marketingConsentAt: null }),
      recipient({ id: "susp", isSuspended: true }),
      recipient({ id: "notoken" }),
      recipient({ id: "capped" }),
      recipient({ id: "conflict" }),
    ]);
    m.pushToken.findMany.mockResolvedValue([{ userId: "ok" }, { userId: "nocons" }, { userId: "susp" }, { userId: "capped" }, { userId: "conflict" }]);
    m.communicationLog.findMany.mockResolvedValue([{ recipientId: "capped" }]);
    m.automationRun.findMany.mockResolvedValue([{ recipientUserId: "conflict" }]);

    const r = await adminCommunicationsService.previewAudience({ audience: "buyers", category: "marketing" }, ACTOR);

    expect(r.total).toBe(6);
    expect(r.channels.in_app.eligible).toBe(2); // ok, notoken
    expect(r.channels.in_app.excluded).toEqual({ no_marketing_consent: 1, suspended: 1, frequency_capped: 1, automation_conflict: 1 });
    expect(r.channels.push.eligible).toBe(1); // ok only
    expect(r.channels.push.excluded.no_push_token).toBe(1);
    expect(r.channels.email.eligible).toBe(2);
  });

  it("excludes marketing push during quiet hours but not an operational notice", async () => {
    quiet.mockReturnValue(true);
    const marketing = await adminCommunicationsService.previewAudience({ audience: "buyers", category: "marketing" }, ACTOR);
    expect(marketing.channels.push.excluded.quiet_hours).toBe(1);
    expect(marketing.quietHours).toBe(true);
    const operational = await adminCommunicationsService.previewAudience({ audience: "buyers", category: "operational" }, ACTOR);
    expect(operational.channels.push.eligible).toBe(1);
  });

  it("operational notices do not require marketing consent", async () => {
    m.user.findMany.mockResolvedValue([recipient({ marketingConsentAt: null })]);
    const r = await adminCommunicationsService.previewAudience({ audience: "buyers", category: "operational" }, ACTOR);
    expect(r.channels.in_app.eligible).toBe(1);
  });

  it("never reaches the sending admin", async () => {
    m.user.findMany.mockResolvedValue([recipient({ id: ACTOR })]);
    const r = await adminCommunicationsService.previewAudience({ audience: "buyers", category: "marketing" }, ACTOR);
    expect(r.channels.in_app.excluded.sender).toBe(1);
  });

  it("is a pure read", async () => {
    await adminCommunicationsService.previewAudience({ audience: "buyers" }, ACTOR);
    expect(push).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(m.notification.create).not.toHaveBeenCalled();
  });
});

describe("broadcast — delivery, gating and logging", () => {
  it("sends to eligible recipients only and writes per-recipient logs with honest statuses", async () => {
    m.user.findMany.mockResolvedValue([recipient({ id: "a" }), recipient({ id: "b", marketingConsentAt: null })]);
    m.pushToken.findMany.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);

    const r = await adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo", idempotencyKey: "k1" });

    expect(r.duplicate).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toBe("a");
    expect(push.mock.calls[0][1].title).toBe("Sale Amara"); // {{name}} rendered per recipient
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].headers).toHaveProperty("List-Unsubscribe"); // marketing email
    expect(m.notification.create).toHaveBeenCalledTimes(1);
    // SENT = handed to Expo — never DELIVERED without a receipt.
    const pushLog = store.logs.find((l) => l.channel === "push")!;
    expect(pushLog.status).toBe("SENT");
    expect(pushLog.statusDetail).toBe("handed_to_expo");
    expect(store.logs.some((l) => l.status === "DELIVERED")).toBe(false);
    expect(r.broadcast.status).toBe("SENT");
    expect(r.counts.push).toMatchObject({ eligible: 1, sent: 1, delivered: 0, failed: 0 });
  });

  it("marks push FAILED (no fake success) when Expo rejects, and the broadcast Partially delivered", async () => {
    push.mockResolvedValue({ tokens: 1, accepted: 0, rejected: 1, error: "InvalidCredentials", ticketIds: [] });
    const r = await adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo" });
    const pushLog = store.logs.find((l) => l.channel === "push")!;
    expect(pushLog.status).toBe("FAILED");
    expect(pushLog.statusDetail).toBe("InvalidCredentials");
    expect(r.broadcast.status).toBe("PARTIALLY_DELIVERED");
  });

  it("reports email as not_configured and sends nothing when the provider is missing", async () => {
    emailOn.mockReturnValue(false);
    const r = await adminCommunicationsService.broadcast(ACTOR, input({ channels: ["email"] }), { reason: "Spring promo" });
    expect(sendMail).not.toHaveBeenCalled();
    expect(r.broadcast.channelResults).toMatchObject({ email: "not_configured" });
    expect(r.broadcast.status).toBe("FAILED");
    expect(r.broadcast.error).toMatch(/not configured/i);
    expect(store.logs).toHaveLength(0);
  });

  it("records a failed email as FAILED with the provider error", async () => {
    sendMail.mockResolvedValue({ ok: false, error: "domain not verified" });
    await adminCommunicationsService.broadcast(ACTOR, input({ channels: ["email"] }), { reason: "Spring promo" });
    expect(store.logs[0]).toMatchObject({ channel: "email", status: "FAILED", statusDetail: "domain not verified" });
  });

  it("is FAILED with an explanation when nobody is eligible", async () => {
    m.user.findMany.mockResolvedValue([recipient({ marketingConsentAt: null })]);
    const r = await adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo" });
    expect(r.broadcast.status).toBe("FAILED");
    expect(r.broadcast.error).toMatch(/no eligible recipients/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("requires a purpose/reason", async () => {
    await expect(adminCommunicationsService.broadcast(ACTOR, input(), { reason: " x " })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("broadcast — idempotency", () => {
  it("a repeated idempotency key returns the existing broadcast and never sends twice", async () => {
    await adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo", idempotencyKey: "same" });
    push.mockClear();
    sendMail.mockClear();

    const second = await adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo", idempotencyKey: "same" });

    expect(second.duplicate).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(store.broadcasts.size).toBe(1);
  });

  it("two concurrent sends with one key create exactly one broadcast", async () => {
    const [a, b] = await Promise.all([
      adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo", idempotencyKey: "race" }),
      adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo", idempotencyKey: "race" }),
    ]);
    expect(store.broadcasts.size).toBe(1);
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
  });
});

describe("broadcast — emergency pause", () => {
  it("refuses to send while commsPaused is on", async () => {
    store.paused = 1;
    await expect(adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo" }))
      .rejects.toMatchObject({ statusCode: 409, code: "COMMS_PAUSED" });
    expect(push).not.toHaveBeenCalled();
    expect(store.broadcasts.size).toBe(0);
  });
});

describe("testSend + mandatory test proof", () => {
  beforeEach(() => {
    m.user.findUnique.mockResolvedValue(recipient({ id: ACTOR, role: "ADMIN", email: "admin@eki.app" }));
  });

  it("returns a per-channel result and a proof token only when every selected channel worked", async () => {
    const r = await adminCommunicationsService.testSend(ACTOR, input());
    expect(r.passed).toBe(true);
    expect(r.testToken).toBeTruthy();
    expect(r.results.push).toMatchObject({ ok: true, status: "handed_to_expo" });
    expect(r.results.email).toMatchObject({ ok: true });
    expect(m.user.findMany).not.toHaveBeenCalled(); // never touches the real audience
  });

  it("fails the test (no token) when the admin has no device or email is unconfigured", async () => {
    push.mockResolvedValue({ tokens: 0, accepted: 0, rejected: 0, ticketIds: [] });
    emailOn.mockReturnValue(false);
    const r = await adminCommunicationsService.testSend(ACTOR, input());
    expect(r.passed).toBe(false);
    expect(r.testToken).toBeUndefined();
    expect(r.results.push?.status).toBe("no_device");
    expect(r.results.email?.status).toBe("not_configured");
  });

  it("the Send gate accepts the proof only for the same admin and exact content", async () => {
    const i = input();
    const { testToken } = await adminCommunicationsService.testSend(ACTOR, i);
    expect(() => adminCommunicationsService.assertTestPassed(ACTOR, i, testToken)).not.toThrow();
    expect(() => adminCommunicationsService.assertTestPassed(ACTOR, input({ body: "changed" }), testToken)).toThrow(/test/i);
    expect(() => adminCommunicationsService.assertTestPassed("other-admin", i, testToken)).toThrow(/test/i);
    expect(() => adminCommunicationsService.assertTestPassed(ACTOR, i, undefined)).toThrow(/test/i);
  });
});

// ─── Canonical message events (broadcast path) ──────────────────────────────
import { eventsService as bcEvents } from "../modules/events/events.service";

describe("broadcast -> canonical message events", () => {
  const emit = vi.spyOn(bcEvents, "emit").mockImplementation(() => undefined);
  const evs = () => emit.mock.calls.map((c) => c[0]);

  it("in-app stored -> delivered, push/email handed to provider -> queued (never delivered without a receipt)", async () => {
    emit.mockClear();
    m.user.findMany.mockResolvedValue([recipient({ id: "a" })]);
    m.pushToken.findMany.mockResolvedValue([{ userId: "a" }]);
    await adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo", idempotencyKey: "ev1" });
    const byChannel = Object.fromEntries(evs().map((e) => [(e.payload as any).channel, e.name]));
    expect(byChannel.in_app).toBe("message_delivered");
    expect(byChannel.push).toBe("message_queued");
    expect(byChannel.email).toBe("message_queued");
    expect(evs().every((e) => e.entityType === "CommunicationLog" && e.source === "admin_broadcast")).toBe(true);
  });

  it("a rejected push emits message_failed with the provider reason", async () => {
    emit.mockClear();
    push.mockResolvedValue({ tokens: 1, accepted: 0, rejected: 1, error: "InvalidCredentials", ticketIds: [] });
    await adminCommunicationsService.broadcast(ACTOR, input(), { reason: "Spring promo" });
    const failed = evs().filter((e) => e.name === "message_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({ channel: "push", reason: "InvalidCredentials" });
  });
});
