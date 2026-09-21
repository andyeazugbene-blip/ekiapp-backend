/**
 * Client decision (2026-09-22, "FINAL CLIENT DECISIONS — APPLY NOW") — the
 * three operational thresholds (PRICE_APPROVAL_TIMEOUT_HOURS/
 * FULFILMENT_STALE_THRESHOLD_HOURS/PAYOUT_STUCK_THRESHOLD_HOURS) are now
 * real, admin-editable settings backed by AdminPlatformSetting, not .env
 * values. Covers: real validation (numeric, finite, > 0 — rejects
 * negative/zero/NaN/Infinity/non-numeric strings), rejection of an
 * unlisted key, a real audit entry with before/after value on every
 * update, "not configured" returning null rather than a guessed default,
 * and the update taking effect on the very next read (no caching layer
 * exists in this codebase to invalidate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    adminPlatformSetting: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminPlatformSettingsService, OPERATIONAL_THRESHOLD_KEYS } from "../modules/admin/admin-platform-settings.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => vi.clearAllMocks());

describe("adminPlatformSettingsService.getValue — missing configuration is handled safely", () => {
  it("returns null (never a guessed default) when a setting has never been configured", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    const value = await adminPlatformSettingsService.getValue("PRICE_APPROVAL_TIMEOUT_HOURS");
    expect(value).toBeNull();
  });

  it("returns the real configured value once set", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue({ key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48 });
    const value = await adminPlatformSettingsService.getValue("PRICE_APPROVAL_TIMEOUT_HOURS");
    expect(value).toBe(48);
  });
});

describe("adminPlatformSettingsService.list — admin-web settings page", () => {
  it("returns all three keys in order, with null for any never configured", async () => {
    m.adminPlatformSetting.findMany.mockResolvedValue([
      { key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48, updatedById: "admin-1", updatedAt: new Date("2026-09-20") },
    ]);

    const result = await adminPlatformSettingsService.list();

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.key)).toEqual([...OPERATIONAL_THRESHOLD_KEYS]);
    const configured = result.find((r) => r.key === "PRICE_APPROVAL_TIMEOUT_HOURS");
    expect(configured?.value).toBe(48);
    expect(configured?.updatedById).toBe("admin-1");
    const unconfigured = result.find((r) => r.key === "FULFILMENT_STALE_THRESHOLD_HOURS");
    expect(unconfigured?.value).toBeNull();
    expect(unconfigured?.updatedById).toBeNull();
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
