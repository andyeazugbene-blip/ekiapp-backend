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

describe("automationService.scheduleAutomation", () => {
  it("suppresses during quiet hours without touching the database", async () => {
    vi.setSystemTime(new Date("2026-06-15T23:30:00.000Z")); // 23:30 UTC — quiet hours
    await automationService.scheduleAutomation(baseInput);
    expect(m.user.findUnique).not.toHaveBeenCalled();
    expect(m.automationRun.create).not.toHaveBeenCalled();
    expect(mSend).not.toHaveBeenCalled();
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
    mSend.mockResolvedValue(undefined as never);

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
});
