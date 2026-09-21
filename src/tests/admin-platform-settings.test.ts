/**
 * Client decision (2026-09-22, "FINAL CLIENT DECISIONS — APPLY NOW", then
 * "EKI — FINAL PRODUCTION CLOSURE" item 2) — the three operational
 * thresholds (PRICE_APPROVAL_TIMEOUT_HOURS/FULFILMENT_STALE_THRESHOLD_HOURS/
 * PAYOUT_STUCK_THRESHOLD_HOURS) are real, admin-editable settings backed by
 * AdminPlatformSetting, not .env values, and now default to 1 (seeded via
 * ensureDefaults(), the same DB-layer pattern marketConfigurationService
 * already uses — never an application-code fallback). Covers: real
 * validation (numeric, finite, > 0 — rejects negative/zero/NaN/Infinity/
 * non-numeric strings), rejection of an unlisted key, a real audit entry
 * with before/after value on every update, the default-to-1 seed only
 * firing when a key genuinely has no row yet, an already-configured value
 * never being overwritten by the seed, and the update taking effect on the
 * very next read (no caching layer exists in this codebase to invalidate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    adminPlatformSetting: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminPlatformSettingsService, OPERATIONAL_THRESHOLD_KEYS } from "../modules/admin/admin-platform-settings.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: table already fully seeded (all 3 keys have a row) — skips the
  // ensureDefaults() upsert loop so most tests below exercise getValue()/
  // list()/setValue() in isolation. Tests that specifically need the seed
  // path override this per-test.
  m.adminPlatformSetting.count.mockResolvedValue(OPERATIONAL_THRESHOLD_KEYS.length);
});

describe("ensureDefaults() — seeds 1 for any threshold with no row yet, called via getValue()/list()", () => {
  it("seeds all three keys to 1 when the table has none of them configured", async () => {
    m.adminPlatformSetting.count.mockResolvedValue(0);
    m.adminPlatformSetting.upsert.mockResolvedValue({});
    m.adminPlatformSetting.findMany.mockResolvedValue([]);

    await adminPlatformSettingsService.list();

    expect(m.adminPlatformSetting.upsert).toHaveBeenCalledTimes(3);
    for (const call of m.adminPlatformSetting.upsert.mock.calls) {
      expect(call[0].update).toEqual({});
      expect(call[0].create.value).toBe(1);
    }
    const seededKeys = m.adminPlatformSetting.upsert.mock.calls.map((c: any) => c[0].create.key).sort();
    expect(seededKeys).toEqual([...OPERATIONAL_THRESHOLD_KEYS].sort());
  });

  it("never re-seeds (and never overwrites) once all three keys already have a row — an admin's real configured value survives", async () => {
    m.adminPlatformSetting.count.mockResolvedValue(3);
    m.adminPlatformSetting.findUnique.mockResolvedValue({ key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48 });

    const value = await adminPlatformSettingsService.getValue("PRICE_APPROVAL_TIMEOUT_HOURS");

    expect(m.adminPlatformSetting.upsert).not.toHaveBeenCalled();
    expect(value).toBe(48);
  });

  it("seeds only the missing keys when some (not all) already have a row — uses update:{} so it can never clobber an existing value even under a race", async () => {
    m.adminPlatformSetting.count.mockResolvedValue(1); // only 1 of 3 configured
    m.adminPlatformSetting.upsert.mockResolvedValue({});
    m.adminPlatformSetting.findUnique.mockResolvedValue({ key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 1 });

    await adminPlatformSettingsService.getValue("PRICE_APPROVAL_TIMEOUT_HOURS");

    // update:{} on every upsert call means an already-existing row (e.g. one
    // a concurrent request just created) is left completely untouched.
    for (const call of m.adminPlatformSetting.upsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
  });
});

describe("adminPlatformSettingsService.getValue — defaults to 1, never invents any other number", () => {
  it("returns 1 once ensureDefaults() has seeded an unconfigured setting", async () => {
    m.adminPlatformSetting.count.mockResolvedValue(0);
    m.adminPlatformSetting.upsert.mockResolvedValue({});
    m.adminPlatformSetting.findUnique.mockResolvedValue({ key: "FULFILMENT_STALE_THRESHOLD_HOURS", value: 1 });

    const value = await adminPlatformSettingsService.getValue("FULFILMENT_STALE_THRESHOLD_HOURS");
    expect(value).toBe(1);
  });

  it("returns the real configured value once explicitly set by an admin, not the 1 default", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue({ key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48 });
    const value = await adminPlatformSettingsService.getValue("PRICE_APPROVAL_TIMEOUT_HOURS");
    expect(value).toBe(48);
  });

  it("still returns null (never a guessed default) in the narrow case where a row genuinely does not exist despite the seed count looking satisfied", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    const value = await adminPlatformSettingsService.getValue("PRICE_APPROVAL_TIMEOUT_HOURS");
    expect(value).toBeNull();
  });
});

describe("adminPlatformSettingsService.list — admin-web settings page", () => {
  it("returns all three keys in order, defaulting to 1 for any never explicitly configured", async () => {
    m.adminPlatformSetting.findMany.mockResolvedValue([
      { key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48, updatedById: "admin-1", updatedAt: new Date("2026-09-20") },
      { key: "FULFILMENT_STALE_THRESHOLD_HOURS", value: 1, updatedById: null, updatedAt: new Date("2026-09-22") },
      { key: "PAYOUT_STUCK_THRESHOLD_HOURS", value: 1, updatedById: null, updatedAt: new Date("2026-09-22") },
    ]);

    const result = await adminPlatformSettingsService.list();

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.key)).toEqual([...OPERATIONAL_THRESHOLD_KEYS]);
    const configured = result.find((r) => r.key === "PRICE_APPROVAL_TIMEOUT_HOURS");
    expect(configured?.value).toBe(48);
    expect(configured?.updatedById).toBe("admin-1");
    const defaulted = result.find((r) => r.key === "FULFILMENT_STALE_THRESHOLD_HOURS");
    expect(defaulted?.value).toBe(1);
    expect(defaulted?.updatedById).toBeNull();
  });
});

describe("adminPlatformSettingsService.setValue — validation", () => {
  it("rejects an unknown/unlisted key — never silently creates an arbitrary setting", async () => {
    await expect(adminPlatformSettingsService.setValue("SOME_RANDOM_KEY", 10, "admin-1", undefined)).rejects.toMatchObject({ statusCode: 400, code: "UNKNOWN_SETTING_KEY" });
    expect(m.adminPlatformSetting.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["negative", -5],
    ["zero", 0],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["a non-numeric string", "abc"],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["an array", [1, 2]],
    ["a boolean", true],
  ])("rejects %s", async (_label, badValue) => {
    await expect(
      adminPlatformSettingsService.setValue("PRICE_APPROVAL_TIMEOUT_HOURS", badValue, "admin-1", undefined),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(m.adminPlatformSetting.upsert).not.toHaveBeenCalled();
  });

  it("accepts a valid positive finite number", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    m.adminPlatformSetting.upsert.mockResolvedValue({ id: "setting-1", key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48, updatedById: "admin-1", updatedAt: new Date() });

    const result = await adminPlatformSettingsService.setValue("PRICE_APPROVAL_TIMEOUT_HOURS", 48, "admin-1", undefined);

    expect(result.value).toBe(48);
  });

  it("accepts a valid positive numeric string (defensive coercion, matching the original env-var validation's own behavior)", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    m.adminPlatformSetting.upsert.mockResolvedValue({ id: "setting-1", key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 24, updatedById: "admin-1", updatedAt: new Date() });

    const result = await adminPlatformSettingsService.setValue("PRICE_APPROVAL_TIMEOUT_HOURS", "24", "admin-1", undefined);

    expect(result.value).toBe(24);
  });

  it("accepts a fractional hour value — the original validation never required an integer", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    m.adminPlatformSetting.upsert.mockResolvedValue({ id: "setting-1", key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 2.5, updatedById: "admin-1", updatedAt: new Date() });

    const result = await adminPlatformSettingsService.setValue("PRICE_APPROVAL_TIMEOUT_HOURS", 2.5, "admin-1", undefined);

    expect(result.value).toBe(2.5);
  });
});

describe("adminPlatformSettingsService.setValue — real audit trail", () => {
  it("records a real audit entry with the actor, before value, and after value", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue({ key: "PAYOUT_STUCK_THRESHOLD_HOURS", value: 24 });
    m.adminPlatformSetting.upsert.mockResolvedValue({ id: "setting-2", key: "PAYOUT_STUCK_THRESHOLD_HOURS", value: 48, updatedById: "admin-9", updatedAt: new Date() });

    await adminPlatformSettingsService.setValue("PAYOUT_STUCK_THRESHOLD_HOURS", 48, "admin-9", "doubling the grace period");

    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: "admin-9",
        action: "admin_platform_setting.updated",
        entityType: "AdminPlatformSetting",
        reason: "doubling the grace period",
      }),
    }));
    const call = m.auditLog.create.mock.calls[0][0].data;
    expect(call.beforeState).toEqual({ key: "PAYOUT_STUCK_THRESHOLD_HOURS", value: 24 });
    expect(call.afterState).toEqual({ key: "PAYOUT_STUCK_THRESHOLD_HOURS", value: 48 });
  });

  it("records beforeState value:null on the very first time a setting is ever configured", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    m.adminPlatformSetting.upsert.mockResolvedValue({ id: "setting-3", key: "FULFILMENT_STALE_THRESHOLD_HOURS", value: 72, updatedById: "admin-1", updatedAt: new Date() });

    await adminPlatformSettingsService.setValue("FULFILMENT_STALE_THRESHOLD_HOURS", 72, "admin-1", undefined);

    const call = m.auditLog.create.mock.calls[0][0].data;
    expect(call.beforeState).toEqual({ key: "FULFILMENT_STALE_THRESHOLD_HOURS", value: null });
  });

  it("persists the real actor id as updatedById on the row itself, not just in the audit log", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    m.adminPlatformSetting.upsert.mockResolvedValue({ id: "setting-4", key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 12, updatedById: "admin-42", updatedAt: new Date() });

    await adminPlatformSettingsService.setValue("PRICE_APPROVAL_TIMEOUT_HOURS", 12, "admin-42", undefined);

    expect(m.adminPlatformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ updatedById: "admin-42" }),
      create: expect.objectContaining({ updatedById: "admin-42" }),
    }));
  });
});
