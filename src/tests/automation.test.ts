import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    vendorAutomationSetting: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    automationRun: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    communicationTemplate: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { communicationService } from "../modules/communications/communication.service";
import { automationService } from "../modules/automation/automation.service";

const m = vi.mocked(prisma, true);
const mSend = vi.mocked(communicationService.send);

// Noon UTC — outside the 22:00–07:00 quiet-hours window used by the engine.
const DAYTIME = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(DAYTIME);
  m.communicationTemplate.findUnique.mockResolvedValue(null);
  m.communicationTemplate.create.mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
});

const baseInput = {
  type: "CART_RECOVERY" as const,
  recipientUserId: "buyer-1",
  subjectKey: "cart-1:2026-06-15",
  requiresMarketingConsent: true,
};

/**
 * P0 regression guard: the daily Vercel Cron is the ONLY place that ever
 * invokes any automation trigger (every detector is batch-driven — see
 * automation.detectors.ts and internal.routes.ts). If that cron's schedule
 * ever falls back inside the quiet-hours window (22:00–07:00 UTC), every
 * automation is silently suppressed again, exactly as it was before this
 * fix — with zero error signal. This test reads the real vercel.json and
 * fails loudly if that ever happens again.
 */
describe("Automation cron schedule — must never fall inside quiet hours", () => {
  it("the daily-sweep cron's configured UTC hour is outside 22:00–07:00", () => {
    const vercelConfigPath = join(__dirname, "..", "..", "vercel.json");
    const config = JSON.parse(readFileSync(vercelConfigPath, "utf-8"));
    const dailySweep = config.crons.find((c: { path: string }) => c.path === "/api/internal/jobs/daily-sweep");
    expect(dailySweep).toBeDefined();

    // Standard 5-field cron: "minute hour day month weekday".
    const [, hourField] = dailySweep.schedule.split(" ");
    const hour = Number(hourField);
    expect(Number.isInteger(hour)).toBe(true);
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThan(24);

    const QUIET_HOUR_START_UTC = 22;
    const QUIET_HOUR_END_UTC = 7;
    const isInsideQuietHours = hour >= QUIET_HOUR_START_UTC || hour < QUIET_HOUR_END_UTC;
    expect(isInsideQuietHours).toBe(false);
  });
});

describe("automationService.scheduleAutomation", () => {
  it("suppresses during quiet hours without touching the database", async () => {
    vi.setSystemTime(new Date("2026-06-15T23:30:00.000Z")); // 23:30 UTC — quiet hours
    await automationService.scheduleAutomation(baseInput);
    expect(m.user.findUnique).not.toHaveBeenCalled();
    expect(m.automationRun.create).not.toHaveBeenCalled();
    expect(mSend).not.toHaveBeenCalled();
  });

  it("quiet-hours boundary: 21:59:59 UTC proceeds (not yet quiet hours)", async () => {
    vi.setSystemTime(new Date("2026-06-15T21:59:59.000Z"));
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-boundary-1" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);
    await automationService.scheduleAutomation(baseInput);
    expect(m.automationRun.create).toHaveBeenCalled();
  });

  it("quiet-hours boundary: exactly 22:00:00 UTC suppresses", async () => {
    vi.setSystemTime(new Date("2026-06-15T22:00:00.000Z"));
    await automationService.scheduleAutomation(baseInput);
    expect(m.automationRun.create).not.toHaveBeenCalled();
  });

  it("quiet-hours boundary: exactly 06:59:59 UTC still suppresses", async () => {
    vi.setSystemTime(new Date("2026-06-15T06:59:59.000Z"));
    await automationService.scheduleAutomation(baseInput);
    expect(m.automationRun.create).not.toHaveBeenCalled();
  });

  it("quiet-hours boundary: exactly 07:00:00 UTC proceeds again", async () => {
    vi.setSystemTime(new Date("2026-06-15T07:00:00.000Z"));
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-boundary-2" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);
    await automationService.scheduleAutomation(baseInput);
    expect(m.automationRun.create).toHaveBeenCalled();
  });

  it("the real, current cron hour (12:00 UTC) is never suppressed", async () => {
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-cron-hour" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);
    await automationService.scheduleAutomation(baseInput);
    expect(m.automationRun.create).toHaveBeenCalled();
    expect(mSend).toHaveBeenCalled();
  });

  /**
   * NAV-10 regression guard: input.data was previously only merged into
   * `variables` (template text interpolation) — it never reached the push/
   * in-app `data` payload the frontend's tap-router reads, so even a
   * caller that supplied an entity id (e.g. campaignId) produced a
   * notification with nowhere real to deep-link to. This locks the actual
   * passthrough in place so it can't silently regress.
   */
  it("forwards input.data into communicationService.send()'s data param, for deep-linking", async () => {
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-data-passthrough", dedupeKey: "CAMPAIGN_DEADLINE:campaign-1:deadline:buyer-1" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);

    await automationService.scheduleAutomation({
      ...baseInput,
      type: "CAMPAIGN_DEADLINE",
      data: { campaign_title: "Rice Bulk Buy", campaignId: "campaign-1" },
    });

    expect(mSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: { campaign_title: "Rice Bulk Buy", campaignId: "campaign-1" } }),
    );
  });

  it("passes data: undefined through cleanly when a caller supplies no data at all (e.g. BUYER_WIN_BACK)", async () => {
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-no-data" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);

    await automationService.scheduleAutomation({ ...baseInput, type: "BUYER_WIN_BACK", requiresMarketingConsent: true });

    expect(mSend).toHaveBeenCalledWith(expect.objectContaining({ data: undefined }));
  });

  it("multiple recipients each get an independent run and an independent send (e.g. a campaign milestone fanning out to several participants)", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockImplementation(async ({ data }: any) => ({ id: `run-${data.recipientUserId}`, dedupeKey: data.dedupeKey }) as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);

    await automationService.scheduleAutomation({ ...baseInput, recipientUserId: "participant-1", subjectKey: "campaign-1:milestone:participant-1", requiresMarketingConsent: false });
    await automationService.scheduleAutomation({ ...baseInput, recipientUserId: "participant-2", subjectKey: "campaign-1:milestone:participant-2", requiresMarketingConsent: false });

    expect(m.automationRun.create).toHaveBeenCalledTimes(2);
    expect(mSend).toHaveBeenCalledTimes(2);
    expect(mSend).toHaveBeenNthCalledWith(1, expect.objectContaining({ recipientId: "participant-1" }));
    expect(mSend).toHaveBeenNthCalledWith(2, expect.objectContaining({ recipientId: "participant-2" }));
  });

  it("retries correctly the next day: a fresh, date-scoped subjectKey after a prior FAILED run is not blocked by the old dedupeKey", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date() } as never);

    // Day 1: fails.
    m.automationRun.create.mockResolvedValueOnce({ id: "run-day1" } as never);
    mSend.mockResolvedValueOnce({ outcome: "FAILED", reason: "channel error" } as never);
    await automationService.scheduleAutomation({ ...baseInput, subjectKey: "cart-1:2026-06-15", requiresMarketingConsent: false });
    expect(m.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-day1" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );

    // Day 2 (tomorrow's cron sweep re-detects the same cart, new date-scoped
    // subjectKey — this must NOT be blocked by yesterday's dedupeKey/row).
    m.automationRun.create.mockResolvedValueOnce({ id: "run-day2" } as never);
    mSend.mockResolvedValueOnce({ outcome: "SENT" } as never);
    await automationService.scheduleAutomation({ ...baseInput, subjectKey: "cart-1:2026-06-16", requiresMarketingConsent: false });

    expect(m.automationRun.create).toHaveBeenCalledTimes(2);
    expect(m.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-day2" }, data: expect.objectContaining({ status: "SENT" }) }),
    );
  });

  it("skips a recipient without marketing consent for consent-gated types", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: null } as never);
    await automationService.scheduleAutomation(baseInput);
    expect(m.automationRun.create).not.toHaveBeenCalled();
    expect(mSend).not.toHaveBeenCalled();
  });

  it("does not require marketing consent for operational types", async () => {
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: null } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-1" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Vendor", email: "v@eki.app" } as never);
    await automationService.scheduleAutomation({
      type: "LOW_STOCK_ALERT",
      recipientUserId: "vendor-user-1",
      vendorId: "vendor-1",
      subjectKey: "vendor-1:2026-06-15",
      requiresMarketingConsent: false,
    });
    expect(m.automationRun.create).toHaveBeenCalled();
    expect(mSend).toHaveBeenCalled();
  });

  it("skips when the vendor has disabled this automation type", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: null } as never);
    m.vendorAutomationSetting.findUnique.mockResolvedValue({ enabled: false } as never);
    await automationService.scheduleAutomation({
      type: "LOW_STOCK_ALERT",
      recipientUserId: "vendor-user-1",
      vendorId: "vendor-1",
      subjectKey: "vendor-1:2026-06-15",
      requiresMarketingConsent: false,
    });
    expect(m.automationRun.create).not.toHaveBeenCalled();
  });

  it("respects the frequency cap — skips if a SENT run exists within the window", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.findFirst.mockResolvedValue({ id: "prior-run" } as never);
    await automationService.scheduleAutomation({ ...baseInput, frequencyCapDays: 30 });
    expect(m.automationRun.create).not.toHaveBeenCalled();
    expect(mSend).not.toHaveBeenCalled();
  });

  it("creates a run and sends on the happy path, then marks it SENT", async () => {
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-2" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "SENT" } as never);

    await automationService.scheduleAutomation(baseInput);

    expect(m.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupeKey: `CART_RECOVERY:${baseInput.subjectKey}` }),
      }),
    );
    expect(mSend).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "buyer-1", notificationType: "AUTOMATION_MESSAGE" }));
    expect(m.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-2" }, data: expect.objectContaining({ status: "SENT" }) }),
    );
  });

  it("deduplicates on a unique-constraint violation without sending twice", async () => {
    m.user.findUnique.mockResolvedValue({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockRejectedValue({ code: "P2002" });

    await automationService.scheduleAutomation(baseInput);

    expect(mSend).not.toHaveBeenCalled();
  });

  it("marks the run FAILED (not thrown) if delivery fails", async () => {
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-3" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockRejectedValue(new Error("push failed"));

    await expect(automationService.scheduleAutomation(baseInput)).resolves.toBeUndefined();

    expect(m.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-3" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  /**
   * Status-truth regression: an AutomationRun used to be marked SENT purely
   * because communicationService.send() didn't throw — but send() never
   * throws for a disabled/missing template (or when no channel could be
   * attempted), so a fully suppressed communication was indistinguishable
   * from a genuine delivery on the admin Automation Activity page. send()
   * now reports its real outcome, and scheduleAutomation() must honor it.
   */
  it("marks the run SUPPRESSED (not SENT) when the communication layer reports the template was disabled/missing", async () => {
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-4" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "SUPPRESSED", reason: "Template disabled" } as never);

    await automationService.scheduleAutomation(baseInput);

    expect(m.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-4" },
        data: expect.objectContaining({ status: "SUPPRESSED", suppressedReason: "Template disabled" }),
      }),
    );
    // Explicitly NOT marked SENT or FAILED.
    const call = m.automationRun.update.mock.calls.find((c: any) => c[0].where.id === "run-4");
    expect(call?.[0].data.status).not.toBe("SENT");
    expect(call?.[0].data.status).not.toBe("FAILED");
  });

  it("marks the run FAILED (with the real reason) when every channel failed to dispatch, even though send() didn't throw", async () => {
    m.user.findUnique.mockResolvedValueOnce({ isSuspended: false, marketingConsentAt: new Date() } as never);
    m.automationRun.create.mockResolvedValue({ id: "run-5" } as never);
    m.user.findUnique.mockResolvedValueOnce({ name: "Buyer", email: "b@eki.app" } as never);
    mSend.mockResolvedValue({ outcome: "FAILED", reason: "Every channel failed to dispatch" } as never);

    await automationService.scheduleAutomation(baseInput);

    expect(m.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-5" },
        data: expect.objectContaining({ status: "FAILED", failureReason: "Every channel failed to dispatch" }),
      }),
    );
  });
});

describe("automationService — per-vendor tunable config (CART_RECOVERY, BUYER_WIN_BACK)", () => {
  it("getVendorAutomationConfig falls back to defaults when no row exists", async () => {
    m.vendorAutomationSetting.findUnique.mockResolvedValue(null);
    const config = await automationService.getVendorAutomationConfig("vendor-1", "CART_RECOVERY");
    expect(config).toEqual({ reminderHours: 2 });
  });

  it("getVendorAutomationConfig merges a stored override on top of the defaults", async () => {
    m.vendorAutomationSetting.findUnique.mockResolvedValue({ config: { reminderHours: 24 } } as never);
    const config = await automationService.getVendorAutomationConfig("vendor-1", "CART_RECOVERY");
    expect(config).toEqual({ reminderHours: 24 });
  });

  it("getVendorAutomationConfig defaults BUYER_WIN_BACK inactivityDays to 45", async () => {
    m.vendorAutomationSetting.findUnique.mockResolvedValue(null);
    const config = await automationService.getVendorAutomationConfig("vendor-1", "BUYER_WIN_BACK");
    expect(config).toEqual({ inactivityDays: 45 });
  });

  it("listVendorAutomations exposes merged config only for configurable types", async () => {
    m.vendorAutomationSetting.findMany.mockResolvedValue([
      { type: "CART_RECOVERY", enabled: true, config: { reminderHours: 12 } },
      { type: "FIRST_SALE", enabled: true, config: null },
    ] as never);
    const items = await automationService.listVendorAutomations("vendor-1");
    const cartRecovery = items.find((i) => i.type === "CART_RECOVERY");
    const firstSale = items.find((i) => i.type === "FIRST_SALE");
    expect(cartRecovery?.config).toEqual({ reminderHours: 12 });
    expect(firstSale?.config).toBeNull();
  });

  it("listVendorAutomations never returns a buyer-facing CAMPAIGN_* type — regression for the real-device 'This automation is not available' bug (tapping a CAMPAIGN_* card in Automation Center navigated to a type the frontend's own vendor-type allowlist rejects)", async () => {
    m.vendorAutomationSetting.findMany.mockResolvedValue([]);
    const items = await automationService.listVendorAutomations("vendor-1");
    const types = items.map((i) => i.type);
    expect(types).not.toContain("CAMPAIGN_MILESTONE");
    expect(types).not.toContain("CAMPAIGN_DEADLINE");
    expect(types).not.toContain("CAMPAIGN_REFUND_UPDATE");
    expect(types.sort()).toEqual(
      [
        "FIRST_SALE",
        "CART_RECOVERY",
        "BUYER_WIN_BACK",
        "REVIEW_REQUEST",
        "LOW_STOCK_ALERT",
        "BUYER_REFERRAL",
        "PAYMENT_RECOVERY",
        "RENEWAL_REMINDER",
        "PRICE_APPROVAL_REMINDER",
      ].sort(),
    );
  });

  it("setVendorAutomation persists config for a configurable type", async () => {
    m.vendorAutomationSetting.upsert.mockResolvedValue({} as never);
    await automationService.setVendorAutomation("vendor-1", "BUYER_WIN_BACK", true, { inactivityDays: 90 });
    expect(m.vendorAutomationSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { enabled: true, config: { inactivityDays: 90 } },
        create: expect.objectContaining({ enabled: true, config: { inactivityDays: 90 } }),
      }),
    );
  });

  it("setVendorAutomation ignores a config payload for a non-configurable type", async () => {
    m.vendorAutomationSetting.upsert.mockResolvedValue({} as never);
    await automationService.setVendorAutomation("vendor-1", "FIRST_SALE", true, { anything: 1 });
    expect(m.vendorAutomationSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { enabled: true }, create: expect.objectContaining({ enabled: true }) }),
    );
  });
});
