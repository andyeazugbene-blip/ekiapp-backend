import type { Request } from "express";
import type { AutomationRuleState, AutomationType, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { commsPauseService } from "../communications/comms-pause.service";
import { eventsService, EVENT_NAMES } from "../events/events.service";
import { automationService, DEFAULT_TEMPLATES } from "./automation.service";
import { MARKETING_AUTOMATION_TYPES } from "./automation.types";

export const AUTOMATION_RULE_STATES: AutomationRuleState[] = ["DRAFT", "TEST", "ACTIVE", "PAUSED", "FAILED", "ARCHIVED"];
const ALLOWED_CHANNELS = ["push", "in_app", "email"] as const; // No SMS (product decision 6).
const DAY_MS = 24 * 60 * 60 * 1000;

interface RuleMeta {
  name: string;
  purpose: string;
  trigger: string;
  audience: string;
  feature: string;
  owner?: string;
  frequencyCapDays?: number;
  exclusions: string[];
  stop: string[];
}

const META: Record<AutomationType, RuleMeta> = {
  FIRST_SALE: { name: "First Sale nudge", purpose: "Help a verified vendor with live products get their first paid order.", trigger: "Daily sweep: verified, unsuspended vendor with an active product and no paid order yet.", audience: "Vendors (operational, no marketing consent required).", feature: "Vendor onboarding", frequencyCapDays: 7, exclusions: ["Vendor suspended", "Vendor already has a paid order (unpaid/failed/cancelled orders do not count)"], stop: ["First paid order"] },
  CART_RECOVERY: { name: "Cart Recovery", purpose: "Remind a buyer about items left in their cart.", trigger: "Daily sweep: cart items older than the vendor's reminder delay (default 2h).", audience: "Buyers with marketing consent.", feature: "Cart / Checkout", frequencyCapDays: 1, exclusions: ["No marketing consent", "Vendor turned the automation off"], stop: ["Cart emptied"] },
  BUYER_WIN_BACK: { name: "Buyer Win-back", purpose: "Re-engage buyers who bought from a vendor but not recently.", trigger: "Daily sweep: paid order with the vendor, none within the vendor's inactivity window (default 45 days).", audience: "Past buyers with marketing consent.", feature: "Retention", frequencyCapDays: 30, exclusions: ["No marketing consent", "Vendor turned the automation off"], stop: ["New paid order"] },
  REVIEW_REQUEST: { name: "Review request", purpose: "Ask a buyer to review a delivered order.", trigger: "Daily sweep: order delivered 1-14 days ago with no review.", audience: "Buyers with marketing consent.", feature: "Reviews", exclusions: ["Order already reviewed", "No marketing consent"], stop: ["Review submitted"] },
  LOW_STOCK_ALERT: { name: "Low-stock alert", purpose: "Warn a vendor that products are running low.", trigger: "Daily sweep: active product with stock <= 5.", audience: "Vendors (operational).", feature: "Inventory", frequencyCapDays: 1, exclusions: ["Vendor turned the automation off"], stop: ["Stock replenished"] },
  BUYER_REFERRAL: { name: "Buyer referral prompt", purpose: "Invite repeat buyers to share their referral code.", trigger: "Daily sweep: buyer with a paid order, account >= 3 days old, never referred anyone.", audience: "Buyers with marketing consent.", feature: "Referrals", frequencyCapDays: 30, exclusions: ["No marketing consent", "Already referred someone"], stop: ["First referral"] },
  REORDER_REMINDER: { name: "Reorder reminder", purpose: "Suggest reordering a product after delivery.", trigger: "Daily sweep: order delivered 1-14 days ago, product still in stock, not reordered.", audience: "Buyers with marketing consent.", feature: "Retention", exclusions: ["Product unavailable", "Already reordered"], stop: ["Reorder placed"] },
  CHECKOUT_PAYMENT_FOLLOW_UP: { name: "Checkout follow-up", purpose: "Prompt a buyer to finish an unpaid checkout.", trigger: "Daily sweep: checkout PENDING for 2-48h (status re-read before sending).", audience: "Buyers with marketing consent.", feature: "Checkout", exclusions: ["Checkout paid in the meantime", "No marketing consent"], stop: ["Payment succeeded"] },
  PAYMENT_RECOVERY: { name: "Payment recovery", purpose: "Tell a buyer their payment failed so they can retry.", trigger: "Daily sweep: payment FAILED in last 24h and order still PENDING.", audience: "Buyers (transactional).", feature: "Payments", owner: "Eki Finance", exclusions: ["Order no longer pending"], stop: ["Order paid or cancelled"] },
  RENEWAL_REMINDER: { name: "Foodstuffs Subscription renewal reminder", purpose: "Notify a buyer before their subscription renews.", trigger: "Renewals sweep: upcoming renewal.", audience: "Subscribed buyers (transactional).", feature: "Foodstuffs Subscription", exclusions: [], stop: ["Subscription paused/cancelled"] },
  PRICE_APPROVAL_REMINDER: { name: "Price approval reminder", purpose: "Ask a buyer to approve a vendor price change on an upcoming delivery.", trigger: "Renewals sweep: price change awaiting approval.", audience: "Subscribed buyers (transactional).", feature: "Foodstuffs Subscription", exclusions: [], stop: ["Approved, declined or timed out"] },
  CAMPAIGN_MILESTONE: { name: "Community Buy milestone", purpose: "Tell participants a campaign reached a funding milestone.", trigger: "Campaign contribution reaches a milestone.", audience: "Campaign participants.", feature: "Community Buy", exclusions: [], stop: ["Campaign closed"] },
  CAMPAIGN_DEADLINE: { name: "Community Buy deadline", purpose: "Warn that a campaign closes soon.", trigger: "Campaign deadline approaching.", audience: "Campaign participants / watchers.", feature: "Community Buy", exclusions: [], stop: ["Campaign closed"] },
  CAMPAIGN_REFUND_UPDATE: { name: "Community Buy refund update", purpose: "Keep a participant informed of their refund status.", trigger: "Campaign refund status changes.", audience: "Refund recipients (transactional).", feature: "Community Buy", owner: "Eki Finance", exclusions: [], stop: ["Refund settled"] },
  VENDOR_TRIAL_ENDING: { name: "Vendor trial ending", purpose: "Tell a vendor their 14-day trial ends in 3 days, with plan and billing details.", trigger: "Stripe webhook customer.subscription.trial_will_end (idempotent via WebhookEvent).", audience: "Vendors in trial (transactional).", feature: "Vendor subscription", owner: "Eki Finance", exclusions: ["Unknown subscription"], stop: ["Trial converted or cancelled"] },
};

const RULE_INCLUDE_NOTE = "Enforced by the engine: state, frequency cap, quiet hours, channels. Other fields describe the rule and are not executable.";

function ruleDefaults(type: AutomationType) {
  const meta = META[type];
  const tpl = DEFAULT_TEMPLATES[type];
  return {
    key: type,
    name: meta.name,
    purpose: meta.purpose,
    owner: meta.owner ?? "Eki Operations",
    relatedFeature: meta.feature,
    automationType: type,
    triggerDescription: meta.trigger,
    conditions: { source: "detector" } as Prisma.InputJsonValue,
    exclusions: meta.exclusions as Prisma.InputJsonValue,
    audience: meta.audience,
    timing: {
      frequencyCapDays: meta.frequencyCapDays ?? null,
      quietHoursStartUtc: 22,
      quietHoursEndUtc: 7,
      stopConditions: meta.stop,
    } as Prisma.InputJsonValue,
    channels: tpl.channels as Prisma.InputJsonValue,
  };
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function validateTimingPatch(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("timing must be an object", 400);
  const t = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (t.frequencyCapDays !== undefined) {
    if (t.frequencyCapDays === null) out.frequencyCapDays = null;
    else if (typeof t.frequencyCapDays === "number" && Number.isInteger(t.frequencyCapDays) && t.frequencyCapDays >= 1 && t.frequencyCapDays <= 365) out.frequencyCapDays = t.frequencyCapDays;
    else throw new AppError("timing.frequencyCapDays must be an integer 1-365 or null", 400);
  }
  for (const k of ["quietHoursStartUtc", "quietHoursEndUtc"] as const) {
    if (t[k] !== undefined) {
      if (typeof t[k] === "number" && Number.isInteger(t[k]) && (t[k] as number) >= 0 && (t[k] as number) <= 23) out[k] = t[k];
      else throw new AppError(`timing.${k} must be an integer hour 0-23`, 400);
    }
  }
  if (t.stopConditions !== undefined) {
    if (!Array.isArray(t.stopConditions) || t.stopConditions.some((s) => typeof s !== "string")) throw new AppError("timing.stopConditions must be a string array", 400);
    out.stopConditions = t.stopConditions;
  }
  return out;
}

export function deliveryState(run: { status: string; channels: { status: string; deliveredAt: string | Date | null }[] }): string {
  switch (run.status) {
    case "SUPPRESSED": return "Suppressed";
    case "FAILED": return "Failed";
    case "CANCELLED": return "Cancelled";
    case "QUEUED": return "Queued";
    case "ELIGIBILITY_CHECK":
    case "SCHEDULED": return "Triggered";
    case "SENT": {
      // "Delivered" only when a provider receipt confirmed it - never assumed.
      const confirmed = run.channels.some((c) => c.status === "DELIVERED" || c.deliveredAt);
      return confirmed ? "Delivered" : "Handed to provider";
    }
    default: return run.status;
  }
}

export const automationRulesService = {
  /** Idempotent: creates a rule for every AutomationType that has none; never touches existing rows. */
  async ensureRules(): Promise<void> {
    const keys = Object.keys(META) as AutomationType[];
    const existing = await prisma.automationRule.findMany({ where: { key: { in: keys } }, select: { key: true } });
    const have = new Set(existing.map((r) => r.key));
    for (const type of keys) {
      if (have.has(type)) continue;
      await prisma.automationRule.create({ data: ruleDefaults(type) }).catch((e) => {
        if ((e as { code?: string }).code !== "P2002") throw e;
      });
    }
  },

  async listRules() {
    await automationRulesService.ensureRules();
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [rules, grouped, lastSent, pause] = await Promise.all([
      prisma.automationRule.findMany({ orderBy: [{ relatedFeature: "asc" }, { name: "asc" }] }),
      prisma.automationRun.groupBy({ by: ["ruleKey", "status"], where: { createdAt: { gte: since }, isTest: false }, _count: { id: true } }),
      prisma.automationRun.groupBy({ by: ["ruleKey"], where: { status: "SENT", isTest: false }, _max: { sentAt: true } }),
      commsPauseService.getState(),
    ]);
    const counts = new Map<string, Record<string, number>>();
    for (const g of grouped) {
      const k = g.ruleKey ?? "";
      counts.set(k, { ...(counts.get(k) ?? {}), [g.status]: g._count.id });
    }
    const lastSuccess = new Map(lastSent.map((l) => [l.ruleKey ?? "", l._max.sentAt]));
    return {
      note: RULE_INCLUDE_NOTE,
      automationsPaused: pause.automationsPaused || pause.commsPaused,
      pause,
      items: rules.map((r) => ({
        ...r,
        preview: r.automationType ? { title: DEFAULT_TEMPLATES[r.automationType].title, body: DEFAULT_TEMPLATES[r.automationType].body } : null,
        counts30d: counts.get(r.key) ?? {},
        lastSuccessAt: lastSuccess.get(r.key) ?? null,
      })),
    };
  },

  async getRuleOrThrow(id: string) {
    const rule = await prisma.automationRule.findUnique({ where: { id } });
    if (!rule) throw new AppError("Automation rule not found", 404);
    return rule;
  },

  async updateRule(id: string, patch: Record<string, unknown>, reasonRaw: unknown, adminId: string, request?: Request) {
    const reason = requireAuditReason(reasonRaw);
    const before = await automationRulesService.getRuleOrThrow(id);
    const data: Prisma.AutomationRuleUpdateInput = { version: { increment: 1 }, updatedById: adminId };
    let channels: string[] | undefined;

    if (patch.timing !== undefined) {
      const timingPatch = validateTimingPatch(patch.timing);
      data.timing = { ...((before.timing as object | null) ?? {}), ...timingPatch } as Prisma.InputJsonValue;
    }
    if (patch.channels !== undefined) {
      if (!Array.isArray(patch.channels) || patch.channels.length === 0) throw new AppError("channels must be a non-empty array", 400);
      for (const c of patch.channels) {
        if (!(ALLOWED_CHANNELS as readonly string[]).includes(String(c))) throw new AppError(`Unsupported channel "${String(c)}". Allowed: ${ALLOWED_CHANNELS.join(", ")}`, 400);
      }
      channels = [...new Set(patch.channels.map(String))];
      data.channels = channels as Prisma.InputJsonValue;
    }
    for (const field of ["name", "purpose", "owner", "relatedFeature", "triggerDescription", "audience"] as const) {
      if (patch[field] !== undefined) {
        if (typeof patch[field] !== "string" || !(patch[field] as string).trim()) throw new AppError(`${field} must be a non-empty string`, 400);
        (data as Record<string, unknown>)[field] = (patch[field] as string).trim();
      }
    }
    if (patch.state !== undefined) {
      if (!AUTOMATION_RULE_STATES.includes(patch.state as AutomationRuleState)) throw new AppError("Invalid state", 400);
      data.state = patch.state as AutomationRuleState;
      data.stateReason = reason;
    }

    const after = await prisma.automationRule.update({ where: { id }, data });

    // Channels are really enforced via the admin-editable CommunicationTemplate for this event.
    if (channels && after.automationType) {
      const key = `automation_${after.automationType.toLowerCase()}`;
      const def = DEFAULT_TEMPLATES[after.automationType];
      await prisma.communicationTemplate.upsert({
        where: { key },
        update: { channels },
        create: { key, title: def.title, body: def.body, channels, recipientType: def.recipientType, enabled: true },
      });
    }

    await recordAudit({
      actorId: adminId,
      action: "automation.rule.updated",
      entityType: "AutomationRule",
      entityId: id,
      beforeState: { version: before.version, state: before.state, timing: before.timing, channels: before.channels },
      afterState: { version: after.version, state: after.state, timing: after.timing, channels: after.channels },
      reason,
      request,
    });
    return after;
  },

  async setRuleState(id: string, action: "pause" | "resume" | "archive", reasonRaw: unknown, adminId: string, request?: Request) {
    const reason = requireAuditReason(reasonRaw);
    const before = await automationRulesService.getRuleOrThrow(id);
    const target: AutomationRuleState = action === "pause" ? "PAUSED" : action === "archive" ? "ARCHIVED" : "ACTIVE";
    if (before.state === target) throw new AppError(`Rule is already ${target.toLowerCase()}`, 409);
    if (action === "resume" && before.state === "ARCHIVED") throw new AppError("Archived rules cannot be resumed; duplicate it instead", 409);
    const after = await prisma.automationRule.update({
      where: { id },
      data: { state: target, stateReason: reason, stateBeforeStop: null, version: { increment: 1 }, updatedById: adminId },
    });
    await recordAudit({
      actorId: adminId,
      action: `automation.rule.${action}`,
      entityType: "AutomationRule",
      entityId: id,
      beforeState: { state: before.state, version: before.version },
      afterState: { state: after.state, version: after.version },
      reason,
      request,
    });
    return after;
  },

  async duplicateRule(id: string, reasonRaw: unknown, adminId: string, request?: Request) {
    const reason = requireAuditReason(reasonRaw);
    const src = await automationRulesService.getRuleOrThrow(id);
    const n = (await prisma.automationRule.count({ where: { key: { startsWith: `${src.key}_copy` } } })) + 1;
    // The copy is a DRAFT with no automationType link: documentation/variant only,
    // never executed by a detector (detectors read the rule keyed by AutomationType).
    const copy = await prisma.automationRule.create({
      data: {
        key: `${src.key}_copy${n}`,
        name: `${src.name} (copy)`,
        purpose: src.purpose,
        owner: src.owner,
        relatedFeature: src.relatedFeature,
        triggerDescription: src.triggerDescription,
        conditions: (src.conditions ?? undefined) as Prisma.InputJsonValue | undefined,
        exclusions: (src.exclusions ?? undefined) as Prisma.InputJsonValue | undefined,
        audience: src.audience,
        timing: (src.timing ?? undefined) as Prisma.InputJsonValue | undefined,
        channels: (src.channels ?? undefined) as Prisma.InputJsonValue | undefined,
        state: "DRAFT",
        stateReason: `Duplicated from ${src.key}`,
        updatedById: adminId,
      },
    });
    await recordAudit({
      actorId: adminId, action: "automation.rule.duplicated", entityType: "AutomationRule", entityId: copy.id,
      beforeState: { sourceId: src.id, sourceKey: src.key }, afterState: { key: copy.key, state: copy.state }, reason, request,
    });
    return copy;
  },

  /**
   * Dry-run for a chosen recipient. Records a TEST run (isTest, never counts toward
   * frequency caps or metrics). Sends a real message ONLY when sendToMe is true,
   * and then only to the acting admin, never to the chosen recipient.
   */
  async testRule(id: string, body: { recipientUserId?: string; sendToMe?: boolean }, reasonRaw: unknown, adminId: string, request?: Request) {
    const reason = requireAuditReason(reasonRaw);
    const rule = await automationRulesService.getRuleOrThrow(id);
    if (!rule.automationType) throw new AppError("This rule is not linked to an executable automation type", 409);
    const type = rule.automationType;
    const sendToMe = body.sendToMe === true;
    const recipientId = sendToMe ? adminId : body.recipientUserId;
    if (!recipientId) throw new AppError("recipientUserId is required", 400);
    const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { id: true, name: true, email: true } });
    if (!recipient) throw new AppError("Recipient not found", 404);

    const tpl = DEFAULT_TEMPLATES[type];
    const vendor = await prisma.vendor.findUnique({ where: { userId: recipientId }, select: { id: true } });
    const input = {
      type, recipientUserId: recipientId, vendorId: vendor?.id ?? null, subjectKey: `test:${Date.now()}`,
      requiresMarketingConsent: MARKETING_AUTOMATION_TYPES.includes(type), title: tpl.title, body: tpl.body,
    };
    const eligibility = await automationService.isEligible(input);
    const dedupeKey = `test:${rule.key}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const run = await prisma.automationRun.create({
      data: {
        type, vendorId: input.vendorId, recipientUserId: recipientId, status: "ELIGIBILITY_CHECK", dedupeKey,
        ruleKey: rule.key, isTest: true, data: { test: true, sendToMe, requestedBy: adminId },
      },
    });
    let finalStatus: string;
    if (sendToMe) {
      finalStatus = await automationService.dispatchRun(run, { type, recipientUserId: recipientId, data: { test: true } });
    } else {
      finalStatus = "SUPPRESSED";
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { status: "SUPPRESSED", suppressedReason: eligibility.eligible ? "dry_run_no_message_sent" : `dry_run_${eligibility.reason}` },
      });
    }
    eventsService.emit({ name: EVENT_NAMES.message_test_sent, actorType: "admin", actorId: adminId, entityType: "AutomationRun", entityId: run.id, source: "admin_automation_test", payload: { ruleKey: rule.key, sendToMe } });
    await recordAudit({
      actorId: adminId, action: "automation.rule.test", entityType: "AutomationRule", entityId: id,
      afterState: { runId: run.id, recipientUserId: recipientId, sendToMe, eligible: eligibility.eligible, reason: eligibility.reason ?? null }, reason, request,
    });
    return {
      runId: run.id, status: finalStatus, eligible: eligibility.eligible, ineligibleReason: eligibility.reason ?? null, sentToAdmin: sendToMe,
      preview: { title: tpl.title, body: tpl.body.replace(/\{\{name\}\}/g, recipient.name ?? "there"), channels: (rule.channels as string[] | null) ?? tpl.channels },
    };
  },

  /** Pauses every ACTIVE rule and sets the shared automationsPaused flag (same one W5's Communications page uses). */
  async emergencyStop(reasonRaw: unknown, adminId: string, request?: Request) {
    const reason = requireAuditReason(reasonRaw);
    await automationRulesService.ensureRules();
    const active = await prisma.automationRule.findMany({ where: { state: "ACTIVE" }, select: { id: true } });
    await prisma.automationRule.updateMany({
      where: { state: "ACTIVE" },
      data: { state: "PAUSED", stateBeforeStop: "ACTIVE", stateReason: `emergency_stop: ${reason}`, updatedById: adminId },
    });
    await commsPauseService.setState({ automationsPaused: true }, adminId, reason, request);
    await recordAudit({
      actorId: adminId, action: "automation.emergency_stop", entityType: "AutomationRule",
      afterState: { pausedRules: active.length, automationsPaused: true }, reason, request,
    });
    return { pausedRules: active.length, automationsPaused: true };
  },

  /** Lifts the global flag and restores only the rules the emergency stop paused. */
  async releaseEmergencyStop(reasonRaw: unknown, adminId: string, request?: Request) {
    const reason = requireAuditReason(reasonRaw);
    const restored = await prisma.automationRule.updateMany({
      where: { state: "PAUSED", stateBeforeStop: "ACTIVE", stateReason: { startsWith: "emergency_stop" } },
      data: { state: "ACTIVE", stateBeforeStop: null, stateReason: `emergency_stop_released: ${reason}`, updatedById: adminId },
    });
    await commsPauseService.setState({ automationsPaused: false }, adminId, reason, request);
    await recordAudit({
      actorId: adminId, action: "automation.emergency_stop_released", entityType: "AutomationRule",
      afterState: { restoredRules: restored.count, automationsPaused: false }, reason, request,
    });
    return { restoredRules: restored.count, automationsPaused: false };
  },

  async listRuns(q: Record<string, unknown>) {
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
    const where: Prisma.AutomationRunWhereInput = {};
    if (typeof q.type === "string" && q.type) where.type = q.type as AutomationType;
    if (typeof q.status === "string" && q.status) where.status = q.status as never;
    if (typeof q.ruleKey === "string" && q.ruleKey) where.ruleKey = q.ruleKey;
    if (typeof q.vendorId === "string" && q.vendorId) where.vendorId = q.vendorId;
    if (typeof q.reason === "string" && q.reason) where.OR = [{ suppressedReason: { contains: q.reason, mode: "insensitive" } }, { failureReason: { contains: q.reason, mode: "insensitive" } }];
    if (typeof q.recipient === "string" && q.recipient.trim()) {
      const term = q.recipient.trim();
      where.recipient = { OR: [{ id: term }, { name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] };
    }
    if (q.includeTests !== "true") where.isTest = false;
    const from = parseDate(q.from);
    const to = parseDate(q.to);
    if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

    const rows = await prisma.automationRun.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(typeof q.cursor === "string" && q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { recipient: { select: { id: true, name: true, email: true } }, vendor: { select: { id: true, storeName: true } } },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Refresh channel status from CommunicationLog so provider receipts written
    // after the run (push receipts, email events) show up.
    const logIds = page.flatMap((r) => ((r.channelResults as { communicationLogId?: string }[] | null) ?? []).map((c) => c.communicationLogId).filter((x): x is string => !!x));
    const logs = logIds.length
      ? await prisma.communicationLog.findMany({ where: { id: { in: logIds } }, select: { id: true, status: true, providerRef: true, statusDetail: true, deliveredAt: true } })
      : [];
    const logById = new Map(logs.map((l) => [l.id, l]));

    const items = page.map((r) => {
      const stored = (r.channelResults as { channel: string; communicationLogId: string; status: string; providerRef: string | null; statusDetail: string | null; deliveredAt: string | null }[] | null) ?? [];
      const channels = stored.map((c) => {
        const live = logById.get(c.communicationLogId);
        return live
          ? { channel: c.channel, communicationLogId: c.communicationLogId, status: live.status, providerRef: live.providerRef, statusDetail: live.statusDetail, deliveredAt: live.deliveredAt }
          : { ...c };
      });
      return {
        id: r.id, type: r.type, ruleKey: r.ruleKey, status: r.status, deliveryState: deliveryState({ status: r.status, channels }),
        recipient: r.recipient, vendor: r.vendor, isTest: r.isTest, attempt: r.attempt, retryOfId: r.retryOfId,
        triggerData: r.data, dedupeKey: r.dedupeKey,
        createdAt: r.createdAt, sentAt: r.sentAt, suppressedReason: r.suppressedReason, failureReason: r.failureReason,
        channels, communicationLogId: r.communicationLogId,
      };
    });
    return { items, nextCursor: hasMore ? page[page.length - 1].id : null };
  },

  async failures() {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [failedRuns, suppressedByReason, lastSuccess, providerErrors, failedCount] = await Promise.all([
      prisma.automationRun.findMany({
        where: { status: "FAILED", isTest: false, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" }, take: 50,
        include: { recipient: { select: { id: true, name: true, email: true } } },
      }),
      prisma.automationRun.groupBy({ by: ["suppressedReason"], where: { status: "SUPPRESSED", isTest: false, createdAt: { gte: since } }, _count: { id: true } }),
      prisma.automationRun.groupBy({ by: ["ruleKey"], where: { status: "SENT", isTest: false }, _max: { sentAt: true } }),
      prisma.communicationLog.groupBy({
        by: ["channel", "statusDetail"], where: { status: "FAILED", eventKey: { startsWith: "automation_" }, createdAt: { gte: since } }, _count: { id: true },
      }),
      prisma.automationRun.count({ where: { status: "FAILED", isTest: false, createdAt: { gte: since } } }),
    ]);
    return {
      failedCount30d: failedCount,
      failedRuns: failedRuns.map((r) => ({
        id: r.id, type: r.type, ruleKey: r.ruleKey, recipient: r.recipient, failureReason: r.failureReason, attempt: r.attempt,
        createdAt: r.createdAt, retryOfId: r.retryOfId,
      })),
      suppressedByReason: suppressedByReason.map((s) => ({ reason: s.suppressedReason ?? "unspecified", count: s._count.id })).sort((a, b) => b.count - a.count),
      lastSuccessByRule: lastSuccess.map((l) => ({ ruleKey: l.ruleKey, lastSuccessAt: l._max.sentAt })),
      providerErrors: providerErrors.map((p) => ({ channel: p.channel, detail: p.statusDetail ?? "No detail recorded", count: p._count.id })),
      note: "Background job failures are not persisted as rows; only automation run failures and provider errors on automation messages are shown.",
    };
  },

  async performance() {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [byStatus, byType] = await Promise.all([
      prisma.automationRun.groupBy({ by: ["status"], where: { createdAt: { gte: since }, isTest: false }, _count: { id: true } }),
      prisma.automationRun.groupBy({ by: ["type", "status"], where: { createdAt: { gte: since }, isTest: false }, _count: { id: true } }),
    ]);
    return {
      windowDays: 30,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.id })),
      byType: byType.map((s) => ({ type: s.type, status: s.status, count: s._count.id })),
      note: "Counts of runs only. Revenue attribution / incremental impact is intentionally not shown until an approved comparison method exists.",
    };
  },
};
