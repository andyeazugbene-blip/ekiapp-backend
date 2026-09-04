import type { AutomationType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { communicationService } from "../communications/communication.service";
import { MARKETING_AUTOMATION_TYPES, VENDOR_TOGGLEABLE_AUTOMATION_TYPES, type ScheduleAutomationInput } from "./automation.types";

// Server-time quiet hours (UTC). A per-user-timezone version would need a
// timezone field on User, which doesn't exist yet — documented limitation,
// not silently pretended away.
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
        await communicationService.send({
          eventKey: automationEventKey(input.type),
          recipientId: input.recipientUserId,
          recipientEmail: recipient?.email,
          variables: { name: recipient?.name ?? "there", ...(input.data as Record<string, string> | undefined) },
          notificationType: "AUTOMATION_MESSAGE",
        });
        await prisma.automationRun.update({
          where: { id: run.id },
          data: { status: "SENT", sentAt: new Date() },
        });
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
    const types = VENDOR_TOGGLEABLE_AUTOMATION_TYPES;
    return types.map((type) => {
      const setting = settingByType.get(type);
      return {
        type,
        enabled: setting?.enabled ?? true,
        description: DEFAULT_TEMPLATES[type].body,
        config: CONFIGURABLE_TYPES.has(type) ? { ...DEFAULT_CONFIG[type], ...(setting?.config as object | undefined) } : null,
      };
    });
  },

  async setVendorAutomation(vendorId: string, type: AutomationType, enabled: boolean, config?: Record<string, number>) {
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
    });
  },

  // ─── Admin monitoring ─────────────────────────────────────────────────

  async adminSummary() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [byType, byStatus, recentFailures] = await Promise.all([
      prisma.automationRun.groupBy({ by: ["type"], where: { createdAt: { gte: since } }, _count: { id: true } }),
      prisma.automationRun.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { id: true } }),
      prisma.automationRun.findMany({
        where: { status: "FAILED", createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    return {
      byType: byType.map((t) => ({ type: t.type, count: t._count.id })),
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.id })),
      recentFailures,
    };
  },
};
