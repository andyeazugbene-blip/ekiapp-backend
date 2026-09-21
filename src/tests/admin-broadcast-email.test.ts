/**
 * Phase 3 fix — admin broadcast had no email channel at all (in_app/push/sms
 * only), and no way to preview audience size or test-send before blasting a
 * real audience. These tests cover: the new `channels` array input mode
 * (including email), the legacy combo-string `channel` input mode staying
 * unchanged (regression proof for the refactor from string-parsing to
 * boolean flags), email consent-gating (mirrors the existing SMS gate),
 * audience-count preview, and test-send.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    order: { groupBy: vi.fn(), findMany: vi.fn() },
    notification: { create: vi.fn().mockResolvedValue({}) },
    conversation: { upsert: vi.fn().mockResolvedValue({ id: "conv-1" }) },
    message: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (cb: any) => cb({
      notification: { create: vi.fn().mockResolvedValue({}) },
      conversation: { upsert: vi.fn().mockResolvedValue({ id: "conv-1" }) },
      message: { create: vi.fn().mockResolvedValue({}) },
    })),
  },
}));

vi.mock("../lib/expo-push", () => ({ sendPushToUser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/sms", () => ({ sendSms: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { sendPushToUser } from "../lib/expo-push";
import { sendSms } from "../lib/sms";
import { enqueueEmail } from "../lib/email-queue";
import { adminCommunicationsService } from "../modules/admin/admin-communications.service";

const m = vi.mocked(prisma, true) as any;
const push = vi.mocked(sendPushToUser);
const sms = vi.mocked(sendSms);
const email = vi.mocked(enqueueEmail);

const ACTOR_ID = "admin-1";

function recipient(overrides: Record<string, unknown> = {}) {
  return {
    id: "buyer-1",
    role: "BUYER",
    phone: "+441234567890",
    email: "buyer1@example.com",
    smsMarketingConsentAt: new Date(),
    marketingConsentAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("normalizeInput — legacy channel combo-string (unchanged behavior)", () => {
  it("in_app_push_sms maps to all three legacy flags, email stays false", () => {
    const input = adminCommunicationsService.normalizeInput({
      audience: "buyers", channel: "in_app_push_sms", subject: "Hi", body: "Body",
    });
    expect(input).toMatchObject({ wantsInApp: true, wantsPush: true, wantsSms: true, wantsEmail: false });
  });

  it("rejects an invalid legacy channel string", () => {
    expect(() =>
      adminCommunicationsService.normalizeInput({ audience: "buyers", channel: "bogus", subject: "Hi", body: "Body" }),
    ).toThrow(/invalid broadcast channel/i);
  });
});

describe("normalizeInput — channels array (new mode, supports email)", () => {
  it("derives flags from array membership", () => {
    const input = adminCommunicationsService.normalizeInput({
      audience: "buyers", channels: ["in_app", "email"], subject: "Hi", body: "Body",
    });
    expect(input).toMatchObject({ wantsInApp: true, wantsPush: false, wantsSms: false, wantsEmail: true });
  });

  it("rejects an empty channels array", () => {
    expect(() =>
      adminCommunicationsService.normalizeInput({ audience: "buyers", channels: [], subject: "Hi", body: "Body" }),
    ).toThrow(/at least one delivery channel/i);
  });
});

describe("broadcast — email channel", () => {
  it("queues email only for recipients with marketing consent, skips the rest", async () => {
    m.user.findMany.mockResolvedValue([
      recipient({ id: "buyer-1", marketingConsentAt: new Date() }),
      recipient({ id: "buyer-2", marketingConsentAt: null }),
    ]);

    const input = adminCommunicationsService.normalizeInput({
      audience: "buyers", channels: ["email"], subject: "Sale", body: "20% off",
    });
    const result = await adminCommunicationsService.broadcast(ACTOR_ID, input);

    expect(email).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ to: "buyer1@example.com", subject: "Sale" }));
    expect(result.emailQueued).toBe(1);
    expect(result.emailSkipped).toBe(1);
  });

  it("never emails the actor themself, even if they're in the matched audience", async () => {
    m.user.findMany.mockResolvedValue([recipient({ id: ACTOR_ID })]);

    const input = adminCommunicationsService.normalizeInput({
      audience: "buyers", channels: ["email"], subject: "Sale", body: "20% off",
    });
    await adminCommunicationsService.broadcast(ACTOR_ID, input);

    expect(email).not.toHaveBeenCalled();
  });

  it("does not touch email at all when the email channel isn't selected", async () => {
    m.user.findMany.mockResolvedValue([recipient()]);

    const input = adminCommunicationsService.normalizeInput({
      audience: "buyers", channels: ["push"], subject: "Sale", body: "20% off",
    });
    const result = await adminCommunicationsService.broadcast(ACTOR_ID, input);

    expect(email).not.toHaveBeenCalled();
    expect(result.emailQueued).toBe(0);
    expect(push).toHaveBeenCalled();
  });
});

describe("previewAudience — audience-count", () => {
  it("returns the real matched count using the same resolver broadcast() uses", async () => {
    m.user.findMany.mockResolvedValue([recipient({ id: "a" }), recipient({ id: "b" }), recipient({ id: "c" })]);

    const result = await adminCommunicationsService.previewAudience({ audience: "buyers" });

    expect(result).toEqual({ audienceCount: 3 });
  });

  it("never sends anything — pure read", async () => {
    m.user.findMany.mockResolvedValue([recipient()]);
    await adminCommunicationsService.previewAudience({ audience: "buyers" });

    expect(push).not.toHaveBeenCalled();
    expect(sms).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(m.notification.create).not.toHaveBeenCalled();
  });
});

describe("testSend — sends only to the requesting admin", () => {
  it("sends through every requested channel to the admin's own contact details, not the real audience", async () => {
    m.user.findUnique.mockResolvedValue({
      id: ACTOR_ID, role: "ADMIN", phone: "+440000000000", email: "admin@eki.app",
      smsMarketingConsentAt: null, marketingConsentAt: null,
    });

    const input = adminCommunicationsService.normalizeInput({
      audience: "buyers", channels: ["push", "sms", "email"], subject: "Preview", body: "Test body",
    });
    const result = await adminCommunicationsService.testSend(ACTOR_ID, input);

    expect(push).toHaveBeenCalledWith(ACTOR_ID, expect.objectContaining({ title: "[TEST] Preview" }));
    expect(sms).toHaveBeenCalledWith(expect.objectContaining({ to: "+440000000000" }));
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ to: "admin@eki.app" }));
    expect(result.sentTo).toBe("admin@eki.app");
    expect(m.user.findMany).not.toHaveBeenCalled();
  });

  it("404s for an unknown admin id rather than silently no-op'ing", async () => {
    m.user.findUnique.mockResolvedValue(null);
    const input = adminCommunicationsService.normalizeInput({
      audience: "buyers", channels: ["push"], subject: "Preview", body: "Test body",
    });
    await expect(adminCommunicationsService.testSend(ACTOR_ID, input)).rejects.toMatchObject({ statusCode: 404 });
  });
});
