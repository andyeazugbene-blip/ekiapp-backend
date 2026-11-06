import type { Request } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

/**
 * Owner instruction (2026-11-06): where the client documents leave a decision
 * open, ship a sensible default that an admin can change. Each entry states
 * where its default comes from, so the source is visible in the admin panel.
 *
 * A row exists only once an admin has changed a value, so a default can still
 * be corrected in code until then, and "changed from default" is always known.
 */
type SettingDefinition = {
  group: string;
  label: string;
  help: string;
  default: number;
  min: number;
  max: number;
  /** yes/no settings are stored as 1 and 0. */
  kind: "number" | "toggle";
  unit?: string;
  source: string;
};

export const LAUNCH_SETTINGS = {
  UK_LAUNCH_MODE: {
    group: "Launch",
    label: "UK launch mode",
    help: "Hides country choices in Community Buy and Foodstuff Subscription and uses the United Kingdom. Other markets stay in the system, ready to switch on later.",
    default: 1,
    min: 0,
    max: 1,
    kind: "toggle",
    source: "Phase 1 specification; Handbook 14.9 (temporary rollout setting)",
  },
  VENDOR_TRIAL_DAYS: {
    group: "Vendor plan",
    label: "Vendor free trial",
    help: "Applies to new sign-ups only. Vendors already on a trial keep the end date they were given. Set to 0 for no trial.",
    default: 30,
    min: 0,
    max: 365,
    kind: "number",
    unit: "days",
    source: "Handbook: 30-day full-access trial",
  },
  REVIEW_HOURS_SUPPLIER_ELIGIBILITY: {
    group: "Approvals",
    label: "Review target: supplier application",
    help: "Requests past this target show as overdue in Approvals.",
    default: 72,
    min: 1,
    max: 720,
    kind: "number",
    unit: "hours",
    source: "Phase 1 specification",
  },
  REVIEW_HOURS_SUPPLIER_OFFER: {
    group: "Approvals",
    label: "Review target: supplier offer",
    help: "Requests past this target show as overdue in Approvals.",
    default: 24,
    min: 1,
    max: 720,
    kind: "number",
    unit: "hours",
    source: "Phase 1 specification",
  },
  REVIEW_HOURS_CAMPAIGN: {
    group: "Approvals",
    label: "Review target: first Community Buy",
    help: "Requests past this target show as overdue in Approvals.",
    default: 24,
    min: 1,
    max: 720,
    kind: "number",
    unit: "hours",
    source: "Phase 1 specification",
  },
  REVIEW_HOURS_EXTENSION: {
    group: "Approvals",
    label: "Review target: deadline extension",
    help: "Requests past this target show as overdue in Approvals.",
    default: 24,
    min: 1,
    max: 720,
    kind: "number",
    unit: "hours",
    source: "Phase 1 specification",
  },
  HOLD_HOURS_BEFORE_DEADLINE: {
    group: "Community Buy payments",
    label: "Place card holds before the deadline",
    help: "Only used in markets on the card hold payment mode. New Community Buys only. Holds and the decision together must stay inside a card hold's seven days.",
    default: 48,
    min: 24,
    max: 96,
    kind: "number",
    unit: "hours",
    source: "Community Buy workflow",
  },
  DECISION_HOURS_AFTER_DEADLINE: {
    group: "Community Buy payments",
    label: "Organiser decision time after the deadline",
    help: "Time to choose whether to go ahead below the minimum. New Community Buys only.",
    default: 24,
    min: 24,
    max: 48,
    kind: "number",
    unit: "hours",
    source: "Community Buy workflow",
  },
  ABANDONED_CHECKOUT_MINUTES: {
    group: "Community Buy payments",
    label: "Release an unfinished card save after",
    help: "A buyer's place goes back on sale if they don't finish saving their card in this time.",
    default: 30,
    min: 5,
    max: 1440,
    kind: "number",
    unit: "minutes",
    source: "Engineering default",
  },
} as const satisfies Record<string, SettingDefinition>;

export type LaunchSettingKey = keyof typeof LAUNCH_SETTINGS;

const KEYS = Object.keys(LAUNCH_SETTINGS) as LaunchSettingKey[];

function isLaunchSettingKey(key: string): key is LaunchSettingKey {
  return (KEYS as string[]).includes(key);
}

function validate(key: LaunchSettingKey, raw: unknown): number {
  const definition: SettingDefinition = LAUNCH_SETTINGS[key];
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value)) throw new AppError("value must be a whole number", 400, undefined, "INVALID_SETTING_VALUE");
  if (value < definition.min || value > definition.max) {
    throw new AppError(`value must be between ${definition.min} and ${definition.max}`, 400, undefined, "INVALID_SETTING_VALUE");
  }
  return value;
}

export const launchSettingsService = {
  /**
   * A live read, so a change applies to the next request. A failed read falls
   * back to the documented default: these settings tune flows, and being
   * unable to read one must not stop a checkout or a review.
   */
  async get(key: LaunchSettingKey): Promise<number> {
    try {
      const row = await prisma.adminPlatformSetting.findUnique({ where: { key } });
      return row?.value ?? LAUNCH_SETTINGS[key].default;
    } catch (error) {
      logger.warn("Could not read launch setting, using its default", { key, error: error instanceof Error ? error.message : String(error) });
      return LAUNCH_SETTINGS[key].default;
    }
  },

  async isOn(key: LaunchSettingKey): Promise<boolean> {
    return (await this.get(key)) === 1;
  },

  async list() {
    const rows = await prisma.adminPlatformSetting.findMany({ where: { key: { in: KEYS } } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return KEYS.map((key) => {
      const definition: SettingDefinition = LAUNCH_SETTINGS[key];
      const row = byKey.get(key);
      return {
        key,
        group: definition.group,
        label: definition.label,
        help: definition.help,
        kind: definition.kind,
        unit: definition.unit ?? null,
        min: definition.min,
        max: definition.max,
        source: definition.source,
        defaultValue: definition.default,
        value: row?.value ?? definition.default,
        changedFromDefault: !!row && row.value !== definition.default,
        updatedById: row?.updatedById ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  },

  async set(key: string, rawValue: unknown, adminId: string, reason: string, request?: Request) {
    if (!isLaunchSettingKey(key)) throw new AppError(`Unknown setting key: ${key}`, 400, undefined, "UNKNOWN_SETTING_KEY");
    const value = validate(key, rawValue);
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
      beforeState: { key, value: before?.value ?? LAUNCH_SETTINGS[key].default },
      afterState: { key, value },
      metadata: { key },
      reason,
      request,
      failClosed: true,
    });
    return { key, value, updatedAt: updated.updatedAt };
  },

  /** What the apps need. Holds no admin detail. */
  async publicView() {
    const [ukLaunchMode, vendorTrialDays] = await Promise.all([this.isOn("UK_LAUNCH_MODE"), this.get("VENDOR_TRIAL_DAYS")]);
    return { ukLaunchMode, launchMarket: "GB", vendorTrialDays };
  },
};
