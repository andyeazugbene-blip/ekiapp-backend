import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: { adminPlatformSetting: { findUnique: m.findUnique, findMany: m.findMany, upsert: m.upsert } },
}));
vi.mock("../shared/utils/audit", () => ({ recordAudit: m.recordAudit, requireAuditReason: (reason: string) => reason }));

import { launchSettingsService } from "../modules/admin/launch-settings.service";
import { defaultAuthorisationSchedule } from "../modules/community-buy/community-buy-timing";

beforeEach(() => {
  vi.clearAllMocks();
  m.findUnique.mockResolvedValue(null);
  m.findMany.mockResolvedValue([]);
  m.upsert.mockImplementation(async ({ create }: { create: { key: string; value: number } }) => ({ id: "row", updatedAt: new Date(), ...create }));
});

describe("reading a setting", () => {
  it("uses the documented default until an admin changes it", async () => {
    expect(await launchSettingsService.get("VENDOR_TRIAL_DAYS")).toBe(30);
    expect(await launchSettingsService.isOn("UK_LAUNCH_MODE")).toBe(true);
  });

  it("uses the admin's value once set, including an explicit zero", async () => {
    m.findUnique.mockResolvedValue({ value: 0 });
    expect(await launchSettingsService.get("VENDOR_TRIAL_DAYS")).toBe(0);
    expect(await launchSettingsService.isOn("UK_LAUNCH_MODE")).toBe(false);
  });

  it("falls back to the default if the read fails, so a checkout isn't blocked", async () => {
    m.findUnique.mockRejectedValue(new Error("db down"));
    expect(await launchSettingsService.get("REVIEW_HOURS_SUPPLIER_ELIGIBILITY")).toBe(72);
  });
});

describe("changing a setting", () => {
  it("refuses unknown keys", async () => {
    await expect(launchSettingsService.set("MADE_UP", 1, "admin", "why")).rejects.toMatchObject({ code: "UNKNOWN_SETTING_KEY" });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["VENDOR_TRIAL_DAYS", -1],
    ["VENDOR_TRIAL_DAYS", 366],
    ["VENDOR_TRIAL_DAYS", 1.5],
    ["VENDOR_TRIAL_DAYS", "abc"],
    ["VENDOR_TRIAL_DAYS", ""],
    ["VENDOR_TRIAL_DAYS", null],
    ["UK_LAUNCH_MODE", 2],
    // A shorter lead than one job run would miss holds. A longer one outlives Stripe's card hold.
    ["HOLD_HOURS_BEFORE_DEADLINE", 23],
    ["HOLD_HOURS_BEFORE_DEADLINE", 97],
    ["DECISION_HOURS_AFTER_DEADLINE", 49],
  ])("refuses %s = %s", async (key, value) => {
    await expect(launchSettingsService.set(key, value, "admin", "why")).rejects.toMatchObject({ code: "INVALID_SETTING_VALUE" });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("records who changed what, and from what", async () => {
    await launchSettingsService.set("VENDOR_TRIAL_DAYS", 14, "admin-1", "client asked");
    expect(m.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "admin-1",
      beforeState: { key: "VENDOR_TRIAL_DAYS", value: 30 },
      afterState: { key: "VENDOR_TRIAL_DAYS", value: 14 },
      reason: "client asked",
      failClosed: true,
    }));
  });
});

describe("the admin list and the public view", () => {
  it("marks a changed value", async () => {
    m.findMany.mockResolvedValue([{ key: "VENDOR_TRIAL_DAYS", value: 14, updatedById: "a", updatedAt: new Date() }]);
    const rows = await launchSettingsService.list();
    expect(rows.find((row) => row.key === "VENDOR_TRIAL_DAYS")).toMatchObject({ value: 14, defaultValue: 30, changedFromDefault: true });
    expect(rows.find((row) => row.key === "UK_LAUNCH_MODE")).toMatchObject({ value: 1, changedFromDefault: false });
  });

  it("gives the apps only what they need", async () => {
    expect(await launchSettingsService.publicView()).toEqual({ ukLaunchMode: true, launchMarket: "GB", vendorTrialDays: 30 });
  });
});

describe("hold schedule", () => {
  it("follows the configured hours", () => {
    const deadline = new Date("2026-12-10T12:00:00.000Z");
    const schedule = defaultAuthorisationSchedule(deadline, 72, 48);
    expect(schedule.holdWindowStartsAt.toISOString()).toBe("2026-12-07T12:00:00.000Z");
    expect(schedule.decisionDeadline.toISOString()).toBe("2026-12-12T12:00:00.000Z");
  });
});
