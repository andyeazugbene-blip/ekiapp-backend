import type { AutomationType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";
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

function isQuietHoursNow(): boolean {
  const hour = new Date().getUTCHours();
  return hour >= QUIET_HOUR_START_UTC || hour < QUIET_HOUR_END_UTC;
}

function automationEventKey(type: AutomationType): string {
  return `automation_${type.toLowerCase()}`;
}

// Default templates for each automation type. Seeded into the existing
// CommunicationTemplate table (admin-editable) on first use — same
// bootstrap pattern as ensureDefaultPlanConfigs() in subscriptions.service.ts.
const DEFAULT_TEMPLATES: Record<AutomationType, { title: string; body: string; channels: ("email" | "push" | "in_app")[]; recipientType: "BUYER" | "VENDOR" }> = {
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
    title: "Upcoming Regular Delivery",
    body: "Hi {{name}}, your Regular Delivery from {{store_name}} renews on {{renewal_date}}.",
    channels: ["push", "in_app"],
    recipientType: "BUYER",
  },
  PRICE_APPROVAL_REMINDER: {
    title: "Price change needs your approval",
    body: "Hi {{name}}, {{store_name}} changed a price on your upcoming Regular Delivery. Review and approve to continue.",
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

async function isEligible(input: ScheduleAutomationInput): Promise<{ eligible: boolean; reason?: string }> {
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

  if (input.frequencyCapDays) {
    const since = new Date(Date.now() - input.frequencyCapDays * 24 * 60 * 60 * 1000);
    const recent = await prisma.automationRun.findFirst({
      where: {
        type: input.type,
        recipientUserId: input.recipientUserId,
        status: "SENT",
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (recent) return { eligible: false, reason: "frequency_capped" };
  }

  return { eligible: true };
}

export const automationService = {
  /**
   * The single entry point every trigger/detector calls. Performs
   * eligibility checks (consent, vendor toggle, frequency cap, quiet
   * hours), then — only if eligible — records an AutomationRun and sends
   * via the existing communicationService. Never throws; automation
   * failures must never break the caller's real business logic.
   */
  async scheduleAutomation(input: ScheduleAutomationInput): Promise<void> {
    try {
      // Quiet hours are transient — don't consume the dedupe key, just skip
      // this pass. The next sweep will re-detect and retry later.
      if (isQuietHoursNow()) {
        logger.info("Automation suppressed: quiet hours", { type: input.type, subjectKey: input.subjectKey });
        return;
      }

      const eligibility = await isEligible(input);
      if (!eligibility.eligible) {
        logger.info("Automation not eligible", { type: input.type, subjectKey: input.subjectKey, reason: eligibility.reason });
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
            data: input.data as any,
          },
        });
      } catch (error) {
        if ((error as any)?.code === "P2002") {
          // Already scheduled/sent for this exact subject — this is the
          // primary duplicate-message guard, enforced at the DB level.
          return;
        }
        throw error;
      }

      const recipient = await prisma.user.findUnique({
        where: { id: input.recipientUserId },
        select: { name: true, email: true },
      });

      try {
        const result = await communicationService.send({
          eventKey: automationEventKey(input.type),
          recipientId: input.recipientUserId,
          recipientEmail: recipient?.email,
          variables: { name: recipient?.name ?? "there", ...(input.data as Record<string, string> | undefined) },
          notificationType: "AUTOMATION_MESSAGE",
          // NAV-10 fix: input.data was only ever merged into `variables`
          // (template text interpolation) — it never reached the push/
          // in-app `data` payload the frontend's tap-router reads, so even
          // a caller that supplied an entity id (e.g. campaignId) had no
          // way to make a resulting notification deep-link anywhere.
          // Additive only: every automation type's push previously carried
          // exactly `{ type: eventKey }` and nothing else, so merging this
          // in only adds fields, never changes or removes an existing one.
          data: input.data,
          // Same key as this run's own dedupeKey (below). If a caller already
          // created its own in-app Notification for this exact event (e.g.
          // renewals.service.ts calling notificationsService.enqueue()
          // directly before scheduling this automation, using the identical
          // `${type}:${subjectKey}` key), this second in-app write collides
          // and is silently skipped instead of double-notifying the user.
          dedupeKey: run.dedupeKey,
        });

        // Status truth: SENT must mean the communication layer actually
        // accepted and dispatched it on at least one channel. Previously
        // this branch always wrote "SENT" as long as send() didn't throw —
        // but send() never throws for a disabled/missing template, so a
        // fully suppressed communication (e.g. an admin disabled
        // "automation_renewal_reminder" from the Communications page)
        // showed as a normal successful run on the admin Automation
        // Activity page, indistinguishable from a real delivery.
        if (result.outcome === "SENT") {
          await prisma.automationRun.update({
            where: { id: run.id },
            data: { status: "SENT", sentAt: new Date() },
          });
        } else if (result.outcome === "SUPPRESSED") {
          await prisma.automationRun.update({
            where: { id: run.id },
            data: { status: "SUPPRESSED", suppressedReason: result.reason ?? "Suppressed" },
          });
        } else {
          await prisma.automationRun.update({
            where: { id: run.id },
            data: { status: "FAILED", failureReason: result.reason ?? "Every channel failed to dispatch" },
          });
        }
      } catch (error) {
        await prisma.automationRun.update({
          where: { id: run.id },
          data: { status: "FAILED", failureReason: error instanceof Error ? error.message : String(error) },
        });
      }
    } catch (error) {
      // Automation must never break the caller's real business logic.
      logger.error("Automation scheduling failed", {
        type: input.type,
        subjectKey: input.subjectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

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
