import type { Request } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

/**
 * Client decision (2026-09-22, "FINAL CLIENT DECISIONS — APPLY NOW") —
 * these three operational thresholds are real, admin-editable product
 * settings now, not .env values requiring file/redeploy access. The
 * underlying AdminPlatformSetting model is a generic key/value store (so a
 * future admin-editable numeric setting never needs another migration),
 * but this API deliberately only accepts these three keys — an unlisted
 * key is rejected as unknown, never silently created. Extend this list
 * (and the admin-web page) explicitly if a new setting is approved later.
 */
export const OPERATIONAL_THRESHOLD_KEYS = [
  "PRICE_APPROVAL_TIMEOUT_HOURS",
  "FULFILMENT_STALE_THRESHOLD_HOURS",
  "PAYOUT_STUCK_THRESHOLD_HOURS",
] as const;

export type OperationalThresholdKey = (typeof OPERATIONAL_THRESHOLD_KEYS)[number];

export interface OperationalThresholdSetting {
  key: OperationalThresholdKey;
  value: number | null;
  updatedById: string | null;
  updatedAt: Date | null;
}

function isValidKey(key: string): key is OperationalThresholdKey {
  return (OPERATIONAL_THRESHOLD_KEYS as readonly string[]).includes(key);
}

/** Same shape as the original PRICE_APPROVAL_TIMEOUT_HOURS/etc. env-var validation (config/env.ts) — finite, > 0 — just reachable from a real API body instead of a raw process.env string. */
function validateThresholdValue(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") {
    throw new AppError("value is required", 400);
  }
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new AppError("value must be a number", 400);
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError("value must be a finite number greater than zero", 400);
  }
  return value;
}

export const adminPlatformSettingsService = {
  /**
   * Live DB read every call — this codebase has no caching layer for
   * MarketConfiguration or anything else (verified: nothing under src/lib
   * implements one), so a value set via setValue() below takes effect on
   * the very next read, immediately, for every caller of this function.
   * Returns null — never a guessed default — when the admin has not
   * configured this setting yet; the caller (a scheduler/alerting job) is
   * responsible for treating null as "skip this check, not yet configured"
   * rather than substituting an invented number.
   */
  async getValue(key: OperationalThresholdKey): Promise<number | null> {
    const row = await prisma.adminPlatformSetting.findUnique({ where: { key } });
    return row ? row.value : null;
  },

  /** Admin-web settings page — all three keys, in a stable order, each with its real current value (or null if never configured) and who/when last changed it. */
  async list(): Promise<OperationalThresholdSetting[]> {
    const rows = await prisma.adminPlatformSetting.findMany({
      where: { key: { in: OPERATIONAL_THRESHOLD_KEYS as unknown as string[] } },
    });
    const byKey = new Map(rows.map((row) => [row.key as OperationalThresholdKey, row]));
    return OPERATIONAL_THRESHOLD_KEYS.map((key) => {
      const row = byKey.get(key);
      return {
        key,
        value: row?.value ?? null,
        updatedById: row?.updatedById ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  },

  async setValue(key: string, rawValue: unknown, adminId: string, reason: string | undefined, request?: Request): Promise<OperationalThresholdSetting> {
    if (!isValidKey(key)) {
      throw new AppError(`Unknown setting key: ${key}`, 400, undefined, "UNKNOWN_SETTING_KEY");
    }
    const value = validateThresholdValue(rawValue);

    const before = await prisma.adminPlatformSetting.findUnique({ where: { key } });
    const updated = await prisma.adminPlatformSetting.upsert({
      where: { key },
      update: { value, updatedById: adminId },
      create: { key, value, updatedById: adminId },
    });

    await recordAudit({
      actorId: adminId,
      action: "admin_platform_setting.updated",
      entityType: "AdminPlatformSetting",
      entityId: updated.id,
      beforeState: { key, value: before?.value ?? null },
      afterState: { key, value: updated.value },
      reason,
      request,
    });

    return { key, value: updated.value, updatedById: updated.updatedById, updatedAt: updated.updatedAt };
  },
};
