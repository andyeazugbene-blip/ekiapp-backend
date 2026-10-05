import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    cart: { findMany: vi.fn() },
    vendor: { findMany: vi.fn(), findUnique: vi.fn() },
    vendorAutomationSetting: { findUnique: vi.fn() },
    automationRun: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    automationRule: { findUnique: vi.fn(), updateMany: vi.fn() },
    communicationTemplate: { findUnique: vi.fn(), create: vi.fn() },
    communicationLog: { findMany: vi.fn() },
    vendorSubscription: { findUnique: vi.fn() },
    event: { create: vi.fn() },
    webhookEvent: { deleteMany: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("../modules/communications/communication.service", () => ({ communicationService: { send: vi.fn() } }));
vi.mock("../modules/communications/comms-pause.service", () => ({ commsPauseService: { isAutomationsPaused: vi.fn().mockResolvedValue(false) } }));

import { prisma } from "../lib/prisma";
import { communicationService } from "../modules/communications/communication.service";
import { automationService } from "../modules/automation/automation.service";
import { automationDetectors, FIRST_SALE_PAID_STATUSES } from "../modules/automation/automation.detectors";
import { eventsService } from "../modules/events/events.service";
import { notifyVendorTrialEnding } from "../modules/automation/vendor-trial-ending";
import { deliveryState } from "../modules/automation/automation-rules.service";

const m = vi.mocked(prisma, true);
const mSend = vi.mocked(communicationService.send);

const input = { type: "CART_RECOVERY" as const, recipientUserId: "buyer-1", subjectKey: "cart-1", requiresMarketingConsent: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  m.automationRule.findUnique.mockResolvedValue(null as never);
  m.communicationTemplate.findUnique.mockResolvedValue(null);
  m.communicationTemplate.create.mockResolvedValue({} as never);
  m.cart.findMany.mockResolvedValue([] as never);
  m.communicationLog.findMany.mockResolvedValue([] as never);
  m.event.create.mockResolvedValue({} as never);
});
afterEach(() => vi.useRealTimers());

describe("suppression recording", () => {
  it("records a PAUSED rule as a rule_paused suppression and does not send", async () => {
    m.automationRule.findUnique.mockResolvedValue({ state: "PAUSED", timing: null } as never);
    await automationService.scheduleAutomation(input);
    const data = (m.automationRun.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ status: "SUPPRESSED", suppressedReason: "rule_paused" });
    expect(mSend).not.toHaveBeenCalled();
  });

  it("records ARCHIVED distinctly", async () => {
    m.automationRule.findUnique.mockResolvedValue({ state: "ARCHIVED", timing: null } as never);
    await automationService.scheduleAutomation(input);
    expect((m.automationRun.create.mock.calls[0][0] as { data: { suppressedReason: string } }).data.suppressedReason).toBe("rule_archived");
  });

  it("records recipient_suspended and recipient_not_found", async () => {
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: true, marketingConsentAt: new Date() } as never);
    await automationService.scheduleAutomation(input);
    expect((m.automationRun.create.mock.calls[0][0] as { data: { suppressedReason: string } }).data.suppressedReason).toBe("recipient_suspended");
    m.automationRun.create.mockClear();
    m.user.findUnique.mockResolvedValueOnce(null as never);
    await automationService.scheduleAutomation(input);
    expect((m.automationRun.create.mock.calls[0][0] as { data: { suppressedReason: string } }).data.suppressedReason).toBe("recipient_not_found");
  });

  it("records a duplicate-key collision as a suppression under a different key", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    m.automationRun.create.mockResolvedValueOnce({ id: "sup" } as never);
    await automationService.scheduleAutomation(input);
    expect(mSend).not.toHaveBeenCalled();
    const second = (m.automationRun.create.mock.calls[1][0] as { data: { suppressedReason: string; dedupeKey: string } }).data;
    expect(second.suppressedReason).toBe("duplicate_key");
    expect(second.dedupeKey).toContain(":suppressed:duplicate_key:");
  });

  it("quiet hours do not consume the real dedupeKey, so the same subject can run later", async () => {
    vi.setSystemTime(new Date("2026-06-15T23:00:00.000Z"));
    await automationService.scheduleAutomation(input);
    const quiet = (m.automationRun.create.mock.calls[0][0] as { data: { dedupeKey: string } }).data.dedupeKey;
    expect(quiet).not.toBe("CART_RECOVERY:cart-1");

    vi.setSystemTime(new Date("2026-06-16T12:00:00.000Z"));
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date(), name: "B", email: "b@x.io" } as never);
    m.automationRun.create.mockResolvedValue({ id: "r1", dedupeKey: "CART_RECOVERY:cart-1" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);
    await automationService.scheduleAutomation(input);
    const real = (m.automationRun.create.mock.calls[1][0] as { data: { dedupeKey: string } }).data.dedupeKey;
    expect(real).toBe("CART_RECOVERY:cart-1");
    expect(mSend).toHaveBeenCalledTimes(1);
  });

  it("writes channel results and the CommunicationLog id into the run on send", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date(), name: "B", email: "b@x.io" } as never);
    m.automationRun.create.mockResolvedValue({ id: "r1", dedupeKey: "k" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);
    m.communicationLog.findMany.mockResolvedValue([{ id: "log1", channel: "push", status: "SENT", providerRef: "tkt", statusDetail: null, deliveredAt: null }] as never);
    await automationService.scheduleAutomation(input);
    expect(m.automationRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SENT", communicationLogId: "log1", channelResults: [expect.objectContaining({ channel: "push", providerRef: "tkt" })] }),
    }));
  });
});

describe("honest delivery state", () => {
  it("SENT is only 'Handed to provider' until a receipt confirms delivery", () => {
    expect(deliveryState({ status: "SENT", channels: [{ status: "SENT", deliveredAt: null }] })).toBe("Handed to provider");
    expect(deliveryState({ status: "SENT", channels: [{ status: "DELIVERED", deliveredAt: "2026-06-15T12:01:00Z" }] })).toBe("Delivered");
    expect(deliveryState({ status: "SENT", channels: [] })).toBe("Handed to provider");
  });
});

describe("retryRun", () => {
  const failed = { id: "run-f", type: "CART_RECOVERY", vendorId: null, recipientUserId: "buyer-1", status: "FAILED", dedupeKey: "CART_RECOVERY:cart-1", attempt: 1, data: {}, ruleKey: "CART_RECOVERY" };

  it("creates one new run with a fresh attempt key and sends once", async () => {
    m.automationRun.findUnique.mockResolvedValue(failed as never);
    m.automationRun.findMany.mockResolvedValue([] as never);
    m.automationRun.create.mockResolvedValue({ id: "run-2", dedupeKey: "CART_RECOVERY:cart-1:retry:2" } as never);
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date(), name: "B", email: "b@x.io" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);
    const result = await automationService.retryRun("run-f");
    expect(result.status).toBe("SENT");
    expect((m.automationRun.create.mock.calls[0][0] as { data: { dedupeKey: string; retryOfId: string } }).data).toMatchObject({ dedupeKey: "CART_RECOVERY:cart-1:retry:2", retryOfId: "run-f" });
    expect(mSend).toHaveBeenCalledTimes(1);
  });

  it("refuses to retry twice (successful child) and on concurrent retry (unique key)", async () => {
    m.automationRun.findUnique.mockResolvedValue(failed as never);
    m.automationRun.findMany.mockResolvedValue([{ id: "c", status: "SENT" }] as never);
    await expect(automationService.retryRun("run-f")).rejects.toMatchObject({ statusCode: 409 });

    m.automationRun.findMany.mockResolvedValue([] as never);
    m.automationRun.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(automationService.retryRun("run-f")).rejects.toMatchObject({ statusCode: 409 });
    expect(mSend).not.toHaveBeenCalled();
  });

  it("only FAILED runs are retryable", async () => {
    m.automationRun.findUnique.mockResolvedValue({ ...failed, status: "SENT" } as never);
    await expect(automationService.retryRun("run-f")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("detectors", () => {
  it("FIRST_SALE is only stopped by a PAID-or-later order, never pending/failed/cancelled", async () => {
    m.vendor.findMany.mockResolvedValue([] as never);
    await automationDetectors.runSweep();
    const firstCall = m.vendor.findMany.mock.calls[0][0] as { where: { orderItems: { none: { order: { status: { in: string[] } } } } } };
    const statuses = firstCall.where.orderItems.none.order.status.in;
    expect(statuses).toContain("PAID");
    for (const bad of ["PENDING", "FAILED", "CANCELLED", "REFUNDED"]) expect(statuses).not.toContain(bad);
    expect([...FIRST_SALE_PAID_STATUSES]).toEqual(statuses);
  });

  it("a PAUSED rule makes the sweep skip its detector and record the skip", async () => {
    m.automationRule.findUnique.mockImplementation((async (args: { where: { key: string } }) =>
      args.where.key === "FIRST_SALE" ? { state: "PAUSED", timing: null } : null) as never);
    m.vendor.findMany.mockResolvedValue([] as never);
    const results = await automationDetectors.runSweep();
    expect(results.FIRST_SALE).toBe(0);
    expect(m.automationRule.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "FIRST_SALE" }, data: expect.objectContaining({ lastSkipReason: "rule_paused" }) }));
  });
});

describe("eventsService.emit", () => {
  it("never throws, even when the DB write rejects or prisma is broken", async () => {
    m.event.create.mockRejectedValue(new Error("db down"));
    expect(() => eventsService.emit({ name: "payment_succeeded" })).not.toThrow();
    expect(await eventsService.emitAndWait({ name: "payment_succeeded" })).toBe(false);
    m.event.create.mockImplementation(() => { throw new Error("sync boom"); });
    expect(() => eventsService.emit({ name: "payment_failed" })).not.toThrow();
  });
});

describe("trial_will_end", () => {
  const sub = { id: "stripe-sub-1", trial_end: 1_800_000_000 } as never;

  it("schedules one VENDOR_TRIAL_ENDING run keyed by subscription + trial end (so a redelivery dedupes)", async () => {
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs1", vendorId: "v1", plan: "GROWTH", sellerPlan: { name: "Growth", monthlyPriceCents: 2900, currency: "GBP" } } as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "u1", storeName: "Shop" } as never);
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: null, name: "V", email: "v@x.io" } as never);
    m.automationRun.create.mockResolvedValue({ id: "r", dedupeKey: "k" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);
    expect(await notifyVendorTrialEnding(sub)).toBe("notified");
    const data = (m.automationRun.create.mock.calls[0][0] as { data: { dedupeKey: string; type: string } }).data;
    expect(data.type).toBe("VENDOR_TRIAL_ENDING");
    expect(data.dedupeKey).toBe("VENDOR_TRIAL_ENDING:vs1:1800000000000");
    expect(mSend).toHaveBeenCalledWith(expect.objectContaining({ eventKey: "automation_vendor_trial_ending", variables: expect.objectContaining({ plan_name: "Growth", plan_price: expect.stringContaining("29") }) }));
  });

  it("a second delivery of the same event hits the dedupe key and sends nothing", async () => {
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs1", vendorId: "v1", plan: "GROWTH", sellerPlan: null } as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "u1", storeName: "Shop" } as never);
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: null } as never);
    m.automationRun.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" })).mockResolvedValue({ id: "sup" } as never);
    await notifyVendorTrialEnding(sub);
    expect(mSend).not.toHaveBeenCalled();
  });

  it("ignores an unknown subscription", async () => {
    m.vendorSubscription.findUnique.mockResolvedValue(null as never);
    expect(await notifyVendorTrialEnding(sub)).toBe("ignored");
    expect(m.automationRun.create).not.toHaveBeenCalled();
  });
});
