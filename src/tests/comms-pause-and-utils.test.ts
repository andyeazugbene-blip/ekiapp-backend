/**
 * Emergency pause (commsPaused / automationsPaused), unsubscribe tokens,
 * deep-link validation, template versioning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ settings: new Map<string, number>() }));

vi.mock("../lib/prisma", () => {
  const prisma: any = {
    adminPlatformSetting: {
      findMany: vi.fn(async () => [...db.settings.entries()].map(([key, value]) => ({ key, value, updatedAt: new Date(), updatedById: "a" }))),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        db.settings.set(where.key, (db.settings.has(where.key) ? update : create).value);
        return {};
      }),
    },
    communicationTemplate: { findUnique: vi.fn(), update: vi.fn() },
    communicationTemplateVersion: { findFirst: vi.fn(), create: vi.fn() },
    communicationLog: { create: vi.fn().mockResolvedValue({}) },
    notification: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { prisma };
});
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/expo-push", () => ({ sendPushToUser: vi.fn().mockResolvedValue({ tokens: 1, accepted: 1, rejected: 0, ticketIds: [] }) }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { create: vi.fn().mockResolvedValue({}) } }));
vi.mock("../shared/utils/audit", () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));

import { prisma } from "../lib/prisma";
import { sendPushToUser } from "../lib/expo-push";
import { recordAudit } from "../shared/utils/audit";
import { commsPauseService, resetPauseCache } from "../modules/communications/comms-pause.service";
import { communicationService } from "../modules/communications/communication.service";
import {
  signUnsubscribeToken, validateDeepLink, verifyUnsubscribeToken,
} from "../modules/communications/comms-utils";

const m = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  db.settings.clear();
  resetPauseCache();
  m.communicationTemplate.findUnique.mockResolvedValue(null);
});

describe("emergency pause", () => {
  it("setState requires a reason, stores 1/0, and audits before/after", async () => {
    await expect(commsPauseService.setState({ commsPaused: true }, "admin-1", "no")).rejects.toMatchObject({ statusCode: 400 });
    const state = await commsPauseService.setState({ commsPaused: true }, "admin-1", "Provider incident");
    expect(state.commsPaused).toBe(true);
    expect(state.automationsPaused).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "communications.emergency_pause", reason: "Provider incident",
      beforeState: { commsPaused: false, automationsPaused: false },
      afterState: { commsPaused: true, automationsPaused: false },
    }));
  });

  it("communicationService.send suppresses automation_* events with reason emergency_pause", async () => {
    db.settings.set("automationsPaused", 1);
    const r = await communicationService.send({ eventKey: "automation_cart_recovery", recipientId: "u1", variables: {} });
    expect(r).toEqual({ outcome: "SUPPRESSED", reason: "emergency_pause" });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("pausing comms also stops automations, but transactional events are never paused", async () => {
    db.settings.set("commsPaused", 1);
    expect(await commsPauseService.isAutomationsPaused()).toBe(true);
    const r = await communicationService.send({ eventKey: "buyer_order_shipped", recipientId: "u1", variables: { name: "A", order_number: "1" } });
    expect(r.outcome).toBe("SENT");
    expect(sendPushToUser).toHaveBeenCalled();
  });

  it("fails open if the settings read throws (a DB blip must not stop transactional mail)", async () => {
    m.adminPlatformSetting.findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await commsPauseService.isCommsPaused()).toBe(false);
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips and rejects tampering", () => {
    const token = signUnsubscribeToken("user-123");
    expect(verifyUnsubscribeToken(token)).toBe("user-123");
    const [id, sig] = token.split(".");
    expect(verifyUnsubscribeToken(`${Buffer.from("user-999").toString("base64url")}.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${id}.bad`)).toBeNull();
    expect(verifyUnsubscribeToken("garbage")).toBeNull();
  });
});

describe("deep links", () => {
  it("accepts allow-listed routes with a safe query and rejects everything else", () => {
    expect(validateDeepLink("/(buyer)/orders?id=abc-1")).toBe("/(buyer)/orders?id=abc-1");
    expect(validateDeepLink("")).toBeUndefined();
    expect(() => validateDeepLink("/(admin)/x")).toThrow();
    expect(() => validateDeepLink("javascript:alert(1)")).toThrow();
    expect(() => validateDeepLink("/(buyer)/orders?a=1?b")).toThrow();
  });
});

describe("template versioning", () => {
  const before = { id: "t1", key: "welcome_buyer", title: "Old", body: "Old body", channels: ["email"], enabled: true, recipientType: "BUYER" };

  it("snapshots the baseline on first edit, then the new state, and audits with a reason", async () => {
    m.communicationTemplate.findUnique.mockResolvedValue(before);
    m.communicationTemplateVersion.findFirst.mockResolvedValue(null);
    m.communicationTemplate.update.mockResolvedValue({ ...before, title: "New", channels: ["email", "push"] });

    await communicationService.updateTemplate("welcome_buyer", { title: "New", channels: ["email", "push"] }, { id: "admin-1", reason: "Copy refresh" });

    const versions = m.communicationTemplateVersion.create.mock.calls.map((c: any) => [c[0].data.version, c[0].data.title]);
    expect(versions).toEqual([[1, "Old"], [2, "New"]]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "communication_template.updated", reason: "Copy refresh" }));
  });

  it("rejects invalid channels and unknown templates", async () => {
    await expect(communicationService.updateTemplate("x", { channels: ["sms"] })).rejects.toMatchObject({ statusCode: 400 });
    m.communicationTemplate.findUnique.mockResolvedValue(null);
    await expect(communicationService.updateTemplate("missing", { title: "t" })).rejects.toMatchObject({ statusCode: 404 });
  });
});
