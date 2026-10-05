import type { AutomationType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";
import { commsPauseService } from "../communications/comms-pause.service";
import { eventsService, EVENT_NAMES } from "../events/events.service";
import { AppError } from "../../shared/errors/app-error";
import { getRuleGate, noteRuleRan, noteRuleSkipped } from "./automation-rule-gate";
import { MARKETING_AUTOMATION_TYPES, VENDOR_TOGGLEABLE_AUTOMATION_TYPES, EKI_MANAGED_AUTOMATION_TYPES, type ScheduleAutomationInput } from "./automation.types";

// Server-time quiet hours (UTC). A per-user-timezone version would need a
// timezone field on User, which doesn't exist yet — documented limitation,
// not silently pretended away.
//
// P0 fix (2026-09): every automation trigger in this codebase is currently
// batch-detected, reached only via the single daily Vercel Cron entry
// (vercel.json's "/api/internal/jobs/daily-sweep"). That cron used to run
// at 03:00 UTC — inside this exact window — so every single automation was
// silently suppressed, every day, forever, with no error signal (the
// early-return below fires before any AutomationRun row is even created).
// The cron was moved to 12:00 UTC to fix this. This constant is left
// unchanged and still fully enforced: it exists to protect a real user from
// being messaged at night, and remains meaningful the moment any trigger
// stops being purely cron-batch-driven (e.g. a future real-time trigger).
// See src/tests/automation.test.ts's "cron schedule" describe block for the
// regression test that guards against the cron ever being moved back inside
// this window.
const QUIET_HOUR_START_UTC = 22;
const QUIET_HOUR_END_UTC = 7;

export function isQuietHoursNow(): boolean {
  const hour = new Date().getUTCHours();
  return hour >= QUIET_HOUR_START_UTC || hour < QUIET_HOUR_END_UTC;
}

function automationEventKey(type: AutomationType): string {
  return `automation_${type.toLowerCase()}`;
}

// Default templates for each automation type. Seeded into the existing
// CommunicationTemplate table (admin-editable) on first use — same
// bootstrap pattern as ensureDefaultPlanConfigs() in subscriptions.service.ts.
export const DEFAULT_TEMPLATES: Record<AutomationType, { title: string; body: string; channels: ("email" | "push" | "in_app")[]; recipientType: "BUYER" | "VENDOR" }> = {
  FIRST_SALE: {
    title: "Get your first order",
    body: "Hi {{name}}, your store {{store_name}} is live. Share your store link and add a few more products to attract your first buyer.",
    channels: ["push", "in_app"],
    recipientType: "VENDOR",
  },
  CART_RECOVERY: {
    title: "You left something in your cart",
    body: "Hi {{name}}, you still have items waiting in your Eki cart. Complete your order before they sell out.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  BUYER_WIN_BACK: {
    title: "We miss you at Eki",
    body: "Hi {{name}}, it's been a while — take a look at what's new from your favourite vendors.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  REVIEW_REQUEST: {
    title: "How was your order?",
    body: "Hi {{name}}, your order {{order_number}} was delivered. Leave a quick review to help other buyers.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  LOW_STOCK_ALERT: {
    title: "Low stock alert",
    body: "{{product_count}} product(s) in your store are running low on stock.",
    channels: ["push", "in_app", "email"],
    recipientType: "VENDOR",
  },
  BUYER_REFERRAL: {
    title: "Share Eki, earn rewards",
    body: "Hi {{name}}, share your referral code {{referral_code}} with friends and you'll both get a bonus on their first order.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  REORDER_REMINDER: {
    title: "Time to reorder?",
    body: "Hi {{name}}, you ordered {{product_title}} — need more? It's still available.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  CHECKOUT_PAYMENT_FOLLOW_UP: {
    title: "Complete your purchase",
    body: "Hi {{name}}, your order {{order_number}} is waiting — complete payment to confirm your items.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  PAYMENT_RECOVERY: {
    title: "Your payment didn't go through",
    body: "Hi {{name}}, the payment for order {{order_number}} failed. Retry now to secure your items.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  RENEWAL_REMINDER: {
    title: "Upcoming Foodstuffs Subscription",
    body: "Hi {{name}}, your Foodstuffs Subscription from {{store_name}} renews on {{renewal_date}}.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  PRICE_APPROVAL_REMINDER: {
    title: "Price change needs your approval",
    body: "Hi {{name}}, {{store_name}} changed a price on your upcoming Foodstuffs Subscription delivery. Review and approve to continue.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  CAMPAIGN_MILESTONE: {
    title: "Campaign update",
    body: "{{campaign_title}} just reached {{percent}}% of its target!",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  CAMPAIGN_DEADLINE: {
    title: "Campaign deadline approaching",
    body: "{{campaign_title}} closes soon. Join now before it's too late.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  CAMPAIGN_REFUND_UPDATE: {
    title: "Refund update",
    body: "Your refund for {{campaign_title}} is {{refund_status}}.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  VENDOR_TRIAL_ENDING: {
    title: "Your Eki free trial ends soon",
    body: "Hi {{name}}, your free trial ends on {{trial_end_date}}. After that your {{plan_name}} plan ({{plan_price}}) is billed automatically. Manage your plan in the app before then.",
    channels: ["push", "in_app", "email"],
    recipientType: "VENDOR",
  },
};

// Automation types whose behavior a vendor can tune, and their defaults.
// Kept intentionally narrow — only types the doc specifies concrete tunable
// fields for (CART_RECOVERY: reminder delay, BUYER_WIN_BACK: inactivity
// window). Every other type stays a plain on/off toggle.
export const CONFIGURABLE_TYPES = new Set<AutomationType>(["CART_RECOVERY", "BUYER_WIN_BACK"]);
export const DEFAULT_CONFIG: Record<string, Record<string, number>> = {
  CART_RECOVERY: { reminderHours: 2 },
  BUYER_WIN_BACK: { inactivityDays: 45 },
};

async function ensureTemplate(type: AutomationType): Promise<void> {
  const key = automationEventKey(type);
  const existing = await prisma.communicationTemplate.findUnique({ where: { key } });
  if (existing) return;
  const def = DEFAULT_TEMPLATES[type];
  await prisma.communicationTemplate.create({
    data: { key, title: def.title, body: def.body, channels: def.channels, recipientType: def.recipientType, enabled: true },
  }).catch(() => {
    // Race with a concurrent seeder — harmless, another call already created it.
  });
}

type Timing = { frequencyCapDays?: number; quietHoursStartUtc?: number; quietHoursEndUtc?: number } | null;

function isQuietHoursWith(timing: Timing): boolean {
  const start = timing?.quietHoursStartUtc ?? QUIET_HOUR_START_UTC;
  const end = timing?.quietHoursEndUtc ?? QUIET_HOUR_END_UTC;
  const hour = new Date().getUTCHours();
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

async function isEligible(input: ScheduleAutomationInput, timing: Timing = null): Promise<{ eligible: boolean; reason?: string }> {
  const recipient = await prisma.user.findUnique({
    where: { id: input.recipientUserId },
    select: { isSuspended: true, marketingConsentAt: true },
  });
  if (!recipient) return { eligible: false, reason: "recipient_not_found" };
  if (recipient.isSuspended) return { eligible: false, reason: "recipient_suspended" };

  if (input.requiresMarketingConsent && !recipient.marketingConsentAt) {
    return { eligible: false, reason: "no_marketing_consent" };
  }

  if (input.vendorId) {
    const setting = await prisma.vendorAutomationSetting.findUnique({
      where: { vendorId_type: { vendorId: input.vendorId, type: input.type } },
      select: { enabled: true },
    });
    // No row = default enabled (opt-out model for vendor-level toggles).
    if (setting && !setting.enabled) return { eligible: false, reason: "vendor_disabled_automation" };
  }

  const capDays = timing?.frequencyCapDays ?? input.frequencyCapDays;
  if (capDays) {
    const since = new Date(Date.now() - capDays * 24 * 60 * 60 * 1000);
    const recent = await prisma.automationRun.findFirst({
      where: {
        type: input.type,
        recipientUserId: input.recipientUserId,
        status: "SENT",
        isTest: false,
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (recent) return { eligible: false, reason: "frequency_capped" };
  }

  return { eligible: true };
}

export interface ChannelResult {
  channel: string;
  communicationLogId: string;
  status: string;
  providerRef: string | null;
  statusDetail: string | null;
  deliveredAt: string | null;
}

/**
 * Reads the CommunicationLog rows communicationService.send() just wrote for
 * this recipient/event (send() does not return per-channel detail). Best
 * effort — an empty list just means "no channel detail recorded".
 */
async function collectChannelResults(recipientId: string, eventKey: string, since: Date): Promise<ChannelResult[]> {
  try {
    const rows = await prisma.communicationLog.findMany({
      where: { recipientId, eventKey, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { id: true, channel: true, status: true, providerRef: true, statusDetail: true, deliveredAt: true },
    });
    return rows.map((r) => ({
      channel: r.channel,
      communicationLogId: r.id,
      status: r.status,
      providerRef: r.providerRef ?? null,
      statusDetail: r.statusDetail ?? null,
      deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
    }));
  } catch {
    return [];
  }
}

function dayBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

/**
 * Records a suppression as a visible AutomationRun (handbook 14.10/15.3).
 * The row uses its own suffixed dedupeKey (type:subject:suppressed:reason:day)
 * so it NEVER consumes the real `type:subject` key — the automation can still
 * run later once the condition clears — and at most one row per
 * subject/reason/day is written. Never throws.
 */
async function recordSuppression(input: ScheduleAutomationInput, reason: string, extra?: Record<string, unknown>): Promise<void> {
  eventsService.emit({
    name: EVENT_NAMES.automation_suppressed,
    actorType: "system",
    entityType: "AutomationRun",
    secondaryEntities: { recipientUserId: input.recipientUserId, vendorId: input.vendorId ?? null },
    source: "automation_engine",
    payload: { type: input.type, subjectKey: input.subjectKey, reason },
  });
  try {
    await prisma.automationRun.create({
      data: {
        type: input.type,
        vendorId: input.vendorId ?? null,
        recipientUserId: input.recipientUserId,
        status: "SUPPRESSED",
        suppressedReason: reason,
        dedupeKey: `${input.type}:${input.subjectKey}:suppressed:${reason}:${dayBucket()}`,
        ruleKey: input.type,
        data: { ...(input.data ?? {}), ...(extra ?? {}) } as any,
      },
    });
  } catch (error) {
    // P2002 = already recorded today. Anything else (e.g. FK for a recipient
    // that no longer exists) is logged only: suppression bookkeeping must
    // never break the caller.
    if (!isUniqueViolation(error)) {
      logger.warn("Could not record automation suppression", { type: input.type, reason, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Sends for an already-created run and writes the honest outcome back:
 * channel-level results + CommunicationLog link, SENT only when
 * communicationService actually dispatched (== "handed to provider"; a
 * provider delivery receipt is shown separately, never assumed).
 */
async function dispatchRun(
  run: { id: string; dedupeKey: string },
  params: { type: AutomationType; recipientUserId: string; data?: Record<string, unknown> | null },
): Promise<"SENT" | "SUPPRESSED" | "FAILED"> {
  const recipient = await prisma.user.findUnique({
    where: { id: params.recipientUserId },
    select: { name: true, email: true },
  });
  const startedAt = new Date(Date.now() - 1000);
  const eventKey = automationEventKey(params.type);
  try {
    const result = await communicationService.send({
      eventKey,
      recipientId: params.recipientUserId,
      recipientEmail: recipient?.email,
      variables: { name: recipient?.name ?? "there", ...(params.data as Record<string, string> | undefined) },
      notificationType: "AUTOMATION_MESSAGE",
      // NAV-10: forward entity ids so push/in-app taps can deep-link.
      data: params.data ?? undefined,
      // Same key as this run's dedupeKey so a caller that already wrote its own
      // in-app Notification for this event doesn't get a second one.
      dedupeKey: run.dedupeKey,
    });
    const channelResults = await collectChannelResults(params.recipientUserId, eventKey, startedAt);
    const communicationLogId = channelResults[0]?.communicationLogId ?? null;

    if (result.outcome === "SENT") {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { status: "SENT", sentAt: new Date(), channelResults: channelResults as any, communicationLogId },
      });
      eventsService.emit({
        name: EVENT_NAMES.automation_actioned,
        actorType: "system",
        entityType: "AutomationRun",
        entityId: run.id,
        source: "automation_engine",
        payload: { type: params.type, channels: channelResults.map((c) => c.channel) },
      });
    } else if (result.outcome === "SUPPRESSED") {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { status: "SUPPRESSED", suppressedReason: result.reason ?? "Suppressed", channelResults: channelResults as any, communicationLogId },
      });
    } else {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { status: "FAILED", failureReason: result.reason ?? "Every channel failed to dispatch", channelResults: channelResults as any, communicationLogId },
      });
    }
    return result.outcome;
  } catch (error) {
    await prisma.automationRun.update({
      where: { id: run.id },
      data: { status: "FAILED", failureReason: error instanceof Error ? error.message : String(error) },
    });
    return "FAILED";
  }
}

export const automationService = {
  /**
   * The single entry point every trigger/detector calls. Order of checks:
   * emergency pause -> rule state -> quiet hours -> eligibility (recipient,
   * consent, vendor toggle, frequency cap). EVERY suppression is recorded as
   * an AutomationRun with an explicit suppressedReason. Only an eligible
   * attempt consumes the real `type:subject` dedupeKey. Never throws.
   */
  async scheduleAutomation(input: ScheduleAutomationInput): Promise<void> {
    try {
      // Emergency pause (Communications page, Super Admin): transient — no real
      // dedupe key consumed, the next sweep after resume retries.
      if (await commsPauseService.isAutomationsPaused()) {
        logger.info("Automation suppressed: emergency_pause", { type: input.type, subjectKey: input.subjectKey, reason: "emergency_pause" });
        await recordSuppression(input, "emergency_pause");
        return;
      }

      const gate = await getRuleGate(input.type);
      if (!gate.runnable) {
        await recordSuppression(input, gate.reason ?? "rule_paused");
        await noteRuleSkipped(input.type, gate.reason ?? "rule_paused");
        return;
      }

      // Quiet hours are transient — recorded, but under a distinct key.
      if (!input.bypassQuietHours && isQuietHoursWith(gate.timing)) {
        logger.info("Automation suppressed: quiet hours", { type: input.type, subjectKey: input.subjectKey });
        await recordSuppression(input, "quiet_hours");
        return;
      }

      const eligibility = await isEligible(input, gate.timing);
      if (!eligibility.eligible) {
        logger.info("Automation not eligible", { type: input.type, subjectKey: input.subjectKey, reason: eligibility.reason });
        await recordSuppression(input, eligibility.reason ?? "ineligible");
        return;
      }

      await ensureTemplate(input.type);

      let run;
      try {
        run = await prisma.automationRun.create({
          data: {
            type: input.type,
            vendorId: input.vendorId ?? null,
            recipientUserId: input.recipientUserId,
            status: "ELIGIBILITY_CHECK",
            dedupeKey: `${input.type}:${input.subjectKey}`,
            ruleKey: input.type,
            data: input.data as any,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Already scheduled/sent for this exact subject — the primary
          // duplicate-message guard (DB-level). Recorded, not silent.
          await recordSuppression(input, "duplicate_key");
          return;
        }
        throw error;
      }

      eventsService.emit({
        name: EVENT_NAMES.automation_triggered,
        actorType: "system",
        entityType: "AutomationRun",
        entityId: run.id,
        secondaryEntities: { recipientUserId: input.recipientUserId, vendorId: input.vendorId ?? null },
        source: "automation_engine",
        payload: { type: input.type, subjectKey: input.subjectKey },
      });
      await noteRuleRan(input.type);
      await dispatchRun(run, { type: input.type, recipientUserId: input.recipientUserId, data: input.data });
    } catch (error) {
      // Automation must never break the caller's real business logic.
      logger.error("Automation scheduling failed", {
        type: input.type,
        subjectKey: input.subjectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
   * Admin retry of a FAILED run. Creates a NEW run with a fresh attempt key
   * (`<root>:retry:<n>`, unique) so the consumed original key doesn't block it
   * and a double-click/concurrent retry hits the unique key (409) instead of
   * sending twice. Refuses if an earlier retry already succeeded or is in
   * flight. Eligibility is re-checked at retry time.
   */
  async retryRun(runId: string): Promise<{ id: string; status: string }> {
    const original = await prisma.automationRun.findUnique({ where: { id: runId } });
    if (!original) throw new AppError("Run not found", 404);
    if (original.status !== "FAILED") throw new AppError("Only FAILED runs can be retried", 409);
    const children = await prisma.automationRun.findMany({ where: { retryOfId: original.id }, select: { id: true, status: true } });
    if (children.some((c) => c.status !== "FAILED")) {
      throw new AppError("This run has already been retried", 409);
    }
    const attempt = original.attempt + 1;
    const rootKey = original.dedupeKey.replace(/:retry:\d+$/, "");
    let run;
    try {
      run = await prisma.automationRun.create({
        data: {
          type: original.type,
          vendorId: original.vendorId,
          recipientUserId: original.recipientUserId,
          status: "ELIGIBILITY_CHECK",
          dedupeKey: `${rootKey}:retry:${attempt}`,
          ruleKey: original.ruleKey ?? original.type,
          attempt,
          retryOfId: original.id,
          data: original.data as any,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("This run is already being retried", 409);
      throw error;
    }
    const input: ScheduleAutomationInput = {
      type: original.type,
      recipientUserId: original.recipientUserId,
      vendorId: original.vendorId,
      subjectKey: rootKey,
      requiresMarketingConsent: MARKETING_AUTOMATION_TYPES.includes(original.type),
      title: "",
      body: "",
      data: (original.data as Record<string, unknown> | null) ?? undefined,
    };
    if (await commsPauseService.isAutomationsPaused()) {
      await prisma.automationRun.update({ where: { id: run.id }, data: { status: "SUPPRESSED", suppressedReason: "emergency_pause" } });
      return { id: run.id, status: "SUPPRESSED" };
    }
    const eligibility = await isEligible(input);
    if (!eligibility.eligible) {
      await prisma.automationRun.update({ where: { id: run.id }, data: { status: "SUPPRESSED", suppressedReason: eligibility.reason ?? "ineligible" } });
      return { id: run.id, status: "SUPPRESSED" };
    }
    await ensureTemplate(original.type);
    const outcome = await dispatchRun(run, { type: original.type, recipientUserId: original.recipientUserId, data: input.data });
    return { id: run.id, status: outcome };
  },

  dispatchRun,
  isEligible,

  // ─── Vendor-facing ────────────────────────────────────────────────────

  async listVendorAutomations(vendorId: string) {
    const settings = await prisma.vendorAutomationSetting.findMany({ where: { vendorId } });
    const settingByType = new Map(settings.map((s) => [s.type, s]));

    // Vendor-controlled automations (8): vendor sees toggle + config
    const vendorControlled = VENDOR_TOGGLEABLE_AUTOMATION_TYPES.map((type) => {
      const setting = settingByType.get(type);
      return {
        type,
        managedByEki: false,
        enabled: setting?.enabled ?? true,
        description: DEFAULT_TEMPLATES[type].body,
        config: CONFIGURABLE_TYPES.has(type) ? { ...DEFAULT_CONFIG[type], ...(setting?.config as object | undefined) } : null,
      };
    });

    // Eki-managed automations (3): vendor can see activity but cannot toggle.
    // No enabled/config field exposed — UI must not render a toggle for these.
    const ekiManaged = EKI_MANAGED_AUTOMATION_TYPES.map((type) => ({
      type,
      managedByEki: true,
      description: DEFAULT_TEMPLATES[type].body,
    }));

    return [...vendorControlled, ...ekiManaged];
  },

  async setVendorAutomation(vendorId: string, type: AutomationType, enabled: boolean, config?: Record<string, number>) {
    // Final Client Decision 4: Eki-managed types must NOT expose vendor toggles.
    if ((EKI_MANAGED_AUTOMATION_TYPES as AutomationType[]).includes(type)) {
      throw new Error(`${type} is managed by Eki and cannot be toggled by vendors`);
    }
    if (!VENDOR_TOGGLEABLE_AUTOMATION_TYPES.includes(type)) {
      throw new Error(`${type} is not a vendor-configurable automation type`);
    }
    const data: { enabled: boolean; config?: object } = { enabled };
    if (config && CONFIGURABLE_TYPES.has(type)) data.config = config;
    return prisma.vendorAutomationSetting.upsert({
      where: { vendorId_type: { vendorId, type } },
      update: data,
      create: { vendorId, type, ...data },
    });
  },

  /** Resolves a vendor's tunable config for a configurable automation type, falling back to defaults. */
  async getVendorAutomationConfig(vendorId: string, type: "CART_RECOVERY" | "BUYER_WIN_BACK"): Promise<{ reminderHours: number } | { inactivityDays: number }> {
    const setting = await prisma.vendorAutomationSetting.findUnique({
      where: { vendorId_type: { vendorId, type } },
      select: { config: true },
    });
    return { ...DEFAULT_CONFIG[type], ...(setting?.config as object | undefined) } as any;
  },

  async listVendorActivity(vendorId: string, limit = 50) {
    return prisma.automationRun.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 100),
      include: { recipient: { select: { name: true, email: true } } },
    });
  },

  // ─── Admin monitoring ─────────────────────────────────────────────────

  async adminSummary() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [byType, byStatus, recentFailures, recentSuppressed] = await Promise.all([
      prisma.automationRun.groupBy({ by: ["type"], where: { createdAt: { gte: since } }, _count: { id: true } }),
      prisma.automationRun.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { id: true } }),
      prisma.automationRun.findMany({
        where: { status: "FAILED", createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      // Runs that were correctly NOT sent (disabled/missing template, or no
      // eligible channel) — a real, honest outcome distinct from both
      // "sent" and "failed," now surfaced instead of being indistinguishable
      // from a genuine successful send.
      prisma.automationRun.findMany({
        where: { status: "SUPPRESSED", createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    return {
      byType: byType.map((t) => ({ type: t.type, count: t._count.id })),
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.id })),
      recentFailures,
      recentSuppressed,
    };
  },
};
