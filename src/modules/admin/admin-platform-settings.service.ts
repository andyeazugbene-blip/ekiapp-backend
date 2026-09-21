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

/**
 * Client decision (2026-09-22, "EKI — FINAL PRODUCTION CLOSURE", item 2):
 * these three thresholds now default to 1 (hour) rather than being
 * unconfigured/null. This is implemented entirely in the DB/configuration
 * layer via ensureDefaults() below — the same pattern
 * marketConfigurationService.ensureDefaults() already uses for
 * MarketConfiguration — never as an application-code fallback that bypasses
 * the DB read. A fresh install gets these rows seeded on first read; an
 * existing production environment that has never configured one of these
 * keys gets it seeded to 1 on the next read after this deploy; an already-
 * configured key is never touched (ensureDefaults()'s upsert uses
 * `update: {}`, so a concurrent or pre-existing real value always wins).
 * See also migrations/20260922003000_operational_threshold_defaults for the
 * matching one-time data migration that backfills any already-running
 * production database without waiting for its first read.
 */
const DEFAULT_THRESHOLD_VALUE = 1;

async function ensureDefaults(): Promise<void> {
  const existing = await prisma.adminPlatformSetting.count({
    where: { key: { in: OPERATIONAL_THRESHOLD_KEYS as unknown as string[] } },
  });
  if (existing >= OPERATIONAL_THRESHOLD_KEYS.length) return;
  for (const key of OPERATIONAL_THRESHOLD_KEYS) {
    await prisma.adminPlatformSetting.upsert({
      where: { key },
      update: {},
      create: { key, value: DEFAULT_THRESHOLD_VALUE },
    });
  }
}

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
   * Calls ensureDefaults() first (seeds 1 for any of the three keys with no
   * row yet — see that function's doc comment), so this only returns null
   * in the narrow window before that seed has ever run; callers must still
   * treat null as "skip this check, not yet configured" rather than
   * substituting an invented number — this function itself never invents
   * one.
   */
  async getValue(key: OperationalThresholdKey): Promise<number | null> {
    await ensureDefaults();
    const row = await prisma.adminPlatformSetting.findUnique({ where: { key } });
    return row ? row.value : null;
  },

  /** Admin-web settings page — all three keys, in a stable order, each with its real current value (defaults to 1 via ensureDefaults() if never configured) and who/when last changed it. */
  async list(): Promise<OperationalThresholdSetting[]> {
    await ensureDefaults();
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
