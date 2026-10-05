import { randomUUID } from "crypto";

import { emitMessageEvent } from "../communications/message-events";
import { BroadcastStatus, NotificationType, Prisma, UserRole } from "@prisma/client";

import { isEmailEnabled, sendEmailDetailed } from "../../lib/email";
import { emailTemplates } from "../../lib/email-templates";
import { checkPushReceipts, sendPushToUser } from "../../lib/expo-push";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { isQuietHoursNow } from "../automation/automation.service";
import {
  ALLOWED_DEEP_LINKS,
  broadcastContentHash,
  marketingEmailExtras,
  renderVariables,
  signTestToken,
  unsupportedVariables,
  validateDeepLink,
  verifyTestToken,
} from "../communications/comms-utils";
import { commsPauseService, PAUSE_REASON } from "../communications/comms-pause.service";

export type BroadcastAudience =
  | "all" | "vendors" | "buyers"
  | "active_vendors" | "new_vendors"
  | "individual_vendor" | "individual_buyer" | "individual_user"
  | "last_30_days_buyers" | "repeat_buyers" | "inactive_buyers"
  | "first_time_buyers" | "top_customers"
  | "bought_specific_product";
// Legacy combo-string shape kept so previously-scheduled rows still parse.
// SMS is deliberately not supported: any "sms" part is dropped (product
// decision: no SMS channel in the admin panel).
type BroadcastChannel = "in_app" | "push" | "in_app_push" | "email";
export type SingleChannel = "in_app" | "push" | "email";
export type BroadcastCategory = "marketing" | "operational";

export interface AdminBroadcastInput {
  audience: BroadcastAudience;
  /** Legacy label, kept populated for audit/log readability only. */
  channel: string;
  wantsInApp: boolean;
  wantsPush: boolean;
  wantsEmail: boolean;
  subject: string;
  body: string;
  category: BroadcastCategory;
  deepLink?: string;
  templateKey?: string;
  vendorId?: string;
  userId?: string;
  productId?: string;
}

export const BROADCAST_FREQUENCY_CAP_HOURS = 24;
const AUDIENCE_CAP = 1000;
const SEND_CONCURRENCY = 10;
const MARKETING_EVENT_KEY = "admin_broadcast_marketing";
const OPERATIONAL_EVENT_KEY = "admin_broadcast";

const VALID_AUDIENCES = new Set<BroadcastAudience>([
  "all", "vendors", "buyers", "active_vendors", "new_vendors",
  "individual_vendor", "individual_buyer", "individual_user",
  "last_30_days_buyers", "repeat_buyers", "inactive_buyers",
  "first_time_buyers", "top_customers", "bought_specific_product",
]);
const VALID_LEGACY_CHANNELS = new Set(["in_app", "push", "sms", "in_app_push", "in_app_sms", "in_app_push_sms", "email"]);
const VALID_SINGLE_CHANNELS = new Set<string>(["in_app", "push", "email"]);

export function isIndividualAudience(audience: string): boolean {
  return audience === "individual_vendor" || audience === "individual_buyer" || audience === "individual_user";
}

function normalizeInput(raw: unknown): AdminBroadcastInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const audience = (input.audience ?? "all") as BroadcastAudience;
  const rawSubject = input.subject ?? input.title;
  const subject = typeof rawSubject === "string" ? rawSubject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const vendorId = str(input.vendorId);
  const userId = str(input.userId);
  const productId = str(input.productId);
  const templateKey = str(input.templateKey);

  let wantsInApp: boolean;
  let wantsPush: boolean;
  let wantsEmail: boolean;
  let channelLabel: string;

  if (Array.isArray(input.channels)) {
    const requested = input.channels.filter((c): c is string => typeof c === "string");
    if (requested.includes("sms")) throw new AppError("SMS is not available as a broadcast channel", 400);
    const channelsArray = requested.filter((c) => VALID_SINGLE_CHANNELS.has(c));
    if (channelsArray.length === 0) throw new AppError("At least one delivery channel is required", 400);
    const set = new Set(channelsArray);
    wantsInApp = set.has("in_app");
    wantsPush = set.has("push");
    wantsEmail = set.has("email");
    channelLabel = channelsArray.join("+");
  } else {
    const legacy = (typeof input.channel === "string" ? input.channel : "in_app_push");
    if (!VALID_LEGACY_CHANNELS.has(legacy)) throw new AppError("Invalid broadcast channel", 400);
    wantsInApp = ["in_app", "in_app_push", "in_app_sms", "in_app_push_sms"].includes(legacy);
    wantsPush = ["push", "in_app_push", "in_app_push_sms"].includes(legacy);
    wantsEmail = legacy === "email";
    if (!wantsInApp && !wantsPush && !wantsEmail) throw new AppError("At least one delivery channel is required", 400);
    channelLabel = legacy.replace(/_?sms/, "");
  }

  const categoryRaw = input.category;
  if (categoryRaw !== undefined && categoryRaw !== "marketing" && categoryRaw !== "operational") {
    throw new AppError("category must be marketing or operational", 400);
  }
  const category: BroadcastCategory = categoryRaw === "operational"
    ? "operational"
    : categoryRaw === "marketing" ? "marketing" : (typeof audience === "string" && isIndividualAudience(audience) ? "operational" : "marketing");

  if (!VALID_AUDIENCES.has(audience)) throw new AppError("Invalid broadcast audience", 400);
  if (!subject) throw new AppError("Broadcast subject is required", 400);
  if (!body) throw new AppError("Broadcast body is required", 400);
  if (subject.length > 120) throw new AppError("Broadcast subject is too long", 400);
  if (body.length > 1000) throw new AppError("Broadcast body is too long", 400);
  const badVars = unsupportedVariables(`${subject} ${body}`);
  if (badVars.length > 0) {
    throw new AppError(`Unsupported template variable(s): ${badVars.map((v) => `{{${v}}}`).join(", ")}. Broadcasts support {{name}} and {{store_name}}.`, 400);
  }
  let deepLink: string | undefined;
  try {
    deepLink = validateDeepLink(input.deepLink);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "Invalid deepLink", 400);
  }
  if (audience === "individual_vendor" && !vendorId) throw new AppError("vendorId is required for individual vendor broadcasts", 400);
  if ((audience === "individual_buyer" || audience === "individual_user") && !userId) throw new AppError("userId is required for individual user broadcasts", 400);
  if (audience === "bought_specific_product" && !productId) throw new AppError("productId is required for product-specific broadcasts", 400);

  return {
    audience, channel: channelLabel, wantsInApp, wantsPush, wantsEmail,
    subject, body, category, deepLink, templateKey, vendorId, userId, productId,
  };
}

export function selectedChannels(input: Pick<AdminBroadcastInput, "wantsInApp" | "wantsPush" | "wantsEmail">): SingleChannel[] {
  const out: SingleChannel[] = [];
  if (input.wantsInApp) out.push("in_app");
  if (input.wantsPush) out.push("push");
  if (input.wantsEmail) out.push("email");
  return out;
}

function whereForAudience(audience: BroadcastAudience): Prisma.UserWhereInput {
  // Suspended / anonymised accounts are INCLUDED here on purpose so the
  // preview can report them as excluded (with a reason) instead of hiding them.
  if (audience === "buyers") return { role: UserRole.BUYER };
  if (audience === "vendors") return { role: UserRole.VENDOR };
  if (audience === "active_vendors") return { role: UserRole.VENDOR, vendor: { isSuspended: false } };
  if (audience === "new_vendors") {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return { role: UserRole.VENDOR, createdAt: { gte: sevenDaysAgo } };
  }
  if (
    audience === "last_30_days_buyers" || audience === "repeat_buyers" || audience === "inactive_buyers" ||
    audience === "first_time_buyers" || audience === "top_customers" || audience === "bought_specific_product"
  ) {
    return { role: UserRole.BUYER };
  }
  // "all" = buyers + vendors; admins never receive marketing broadcasts.
  return { role: { in: [UserRole.BUYER, UserRole.VENDOR] } };
}

/**
 * For advanced buyer audiences, after fetching the user list we further filter
 * based on order history. Returns user IDs that match the criteria.
 */
async function resolveAdvancedBuyerAudience(
  audience: BroadcastAudience,
  userIds: string[],
  productId?: string,
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const orderStats = await prisma.order.groupBy({
    by: ["buyerId"],
    where: { buyerId: { in: userIds }, status: { not: "CANCELLED" } },
    _count: { id: true },
    _sum: { totalAmount: true },
    _max: { createdAt: true },
  });

  const statsMap = new Map(orderStats.map((s) => [s.buyerId, {
    orderCount: s._count.id,
    totalSpent: s._sum.totalAmount ?? 0,
    lastOrderAt: s._max.createdAt,
  }]));

  if (audience === "last_30_days_buyers") {
    return userIds.filter((id) => {
      const stat = statsMap.get(id);
      return stat?.lastOrderAt && stat.lastOrderAt >= thirtyDaysAgo;
    });
  }
  if (audience === "repeat_buyers") return userIds.filter((id) => (statsMap.get(id)?.orderCount ?? 0) >= 2);
  if (audience === "inactive_buyers") {
    return userIds.filter((id) => {
      const stat = statsMap.get(id);
      return !stat || !stat.lastOrderAt || stat.lastOrderAt < thirtyDaysAgo;
    });
  }
  if (audience === "first_time_buyers") return userIds.filter((id) => statsMap.get(id)?.orderCount === 1);
  if (audience === "top_customers") {
    const activeBuyers = userIds.filter((id) => {
      const stat = statsMap.get(id);
      return stat && (stat.totalSpent > 0 || stat.orderCount > 0);
    });
    const sorted = [...activeBuyers].sort((a, b) => (statsMap.get(b)?.totalSpent ?? 0) - (statsMap.get(a)?.totalSpent ?? 0));
    const count = Math.max(1, Math.min(25, Math.ceil(sorted.length * 0.2)));
    return sorted.slice(0, count);
  }
  if (audience === "bought_specific_product" && productId) {
    const ordersWithProduct = await prisma.order.findMany({
      where: { buyerId: { in: userIds }, status: { not: "CANCELLED" }, items: { some: { productId } } },
      select: { buyerId: true },
      distinct: ["buyerId"],
    });
    return ordersWithProduct.map((o) => o.buyerId);
  }
  return userIds;
}

type BroadcastRecipient = {
  id: string;
  role: string;
  name: string;
  phone: string | null;
  email: string;
  isSuspended: boolean;
  anonymisedAt: Date | null;
  marketingConsentAt: Date | null;
  vendor?: { storeName: string } | null;
};

const RECIPIENT_SELECT = {
  id: true, role: true, name: true, phone: true, email: true,
  isSuspended: true, anonymisedAt: true, marketingConsentAt: true,
  vendor: { select: { storeName: true } },
} as const;

type AudienceSelector = Pick<AdminBroadcastInput, "audience" | "vendorId" | "userId" | "productId">;

/**
 * The one place audience -> recipient-list resolution happens. Shared by the
 * real send and the read-only preview, so a preview count can never drift
 * from what actually gets sent.
 */
async function resolveRecipients(input: AudienceSelector): Promise<BroadcastRecipient[]> {
  const isAdvancedBuyerAudience = [
    "last_30_days_buyers", "repeat_buyers", "inactive_buyers",
    "first_time_buyers", "top_customers", "bought_specific_product",
  ].includes(input.audience);

  if (isAdvancedBuyerAudience) {
    const allBuyers = await prisma.user.findMany({
      where: whereForAudience(input.audience),
      select: RECIPIENT_SELECT,
      take: AUDIENCE_CAP,
    });
    const matchingIds = await resolveAdvancedBuyerAudience(input.audience, allBuyers.map((u) => u.id), input.productId);
    const idSet = new Set(matchingIds);
    return allBuyers.filter((u) => idSet.has(u.id));
  }
  if (input.audience === "individual_vendor") {
    return prisma.user.findMany({
      where: { vendor: { id: input.vendorId }, role: UserRole.VENDOR },
      select: RECIPIENT_SELECT,
      take: 1,
    });
  }
  if (input.audience === "individual_buyer") {
    return prisma.user.findMany({ where: { id: input.userId, role: UserRole.BUYER }, select: RECIPIENT_SELECT, take: 1 });
  }
  if (input.audience === "individual_user") {
    return prisma.user.findMany({ where: { id: input.userId, role: { in: [UserRole.BUYER, UserRole.VENDOR] } }, select: RECIPIENT_SELECT, take: 1 });
  }
  return prisma.user.findMany({ where: whereForAudience(input.audience), select: RECIPIENT_SELECT, take: AUDIENCE_CAP });
}

// ─── Eligibility (the single policy engine) ─────────────────────────────────

export type ExclusionReason =
  | "sender" | "suspended" | "anonymised" | "no_marketing_consent"
  | "frequency_capped" | "automation_conflict"
  | "no_push_token" | "quiet_hours" | "no_email";

export interface ChannelEligibility {
  eligible: number;
  excluded: Partial<Record<ExclusionReason, number>>;
}

export interface AudienceEvaluation {
  total: number;
  /** True when the audience hit the per-send cap and more people match. */
  capped: boolean;
  category: BroadcastCategory;
  quietHours: boolean;
  channels: Record<SingleChannel, ChannelEligibility>;
  /** Distinct people eligible on at least one of the selected channels. */
  reachable: number;
}

interface Evaluated extends AudienceEvaluation {
  recipients: BroadcastRecipient[];
  decisions: Map<string, Record<SingleChannel, ExclusionReason | null>>;
}

async function evaluateAudience(
  input: AudienceSelector & { category: BroadcastCategory },
  actorId: string | null,
  selected: SingleChannel[],
): Promise<Evaluated> {
  const recipients = await resolveRecipients(input);
  const ids = recipients.map((r) => r.id);
  const marketing = input.category === "marketing";
  const since = new Date(Date.now() - BROADCAST_FREQUENCY_CAP_HOURS * 60 * 60 * 1000);

  const [tokenRows, capRows, conflictRows] = ids.length === 0 ? [[], [], []] : await Promise.all([
    prisma.pushToken.findMany({ where: { userId: { in: ids } }, select: { userId: true }, distinct: ["userId"] }),
    marketing
      ? prisma.communicationLog.findMany({
          where: { recipientId: { in: ids }, eventKey: MARKETING_EVENT_KEY, createdAt: { gte: since }, status: { in: ["QUEUED", "SENT", "DELIVERED"] } },
          select: { recipientId: true },
          distinct: ["recipientId"],
        })
      : Promise.resolve([]),
    marketing
      ? prisma.automationRun.findMany({
          where: { recipientUserId: { in: ids }, status: "SENT", createdAt: { gte: since } },
          select: { recipientUserId: true },
          distinct: ["recipientUserId"],
        })
      : Promise.resolve([]),
  ]);
  const hasToken = new Set(tokenRows.map((r) => r.userId));
  const capped = new Set(capRows.map((r) => r.recipientId));
  const conflicted = new Set(conflictRows.map((r) => r.recipientUserId));
  const quietHours = marketing && isQuietHoursNow();

  const channels: Record<SingleChannel, ChannelEligibility> = {
    in_app: { eligible: 0, excluded: {} },
    push: { eligible: 0, excluded: {} },
    email: { eligible: 0, excluded: {} },
  };
  const decisions = new Map<string, Record<SingleChannel, ExclusionReason | null>>();
  let reachable = 0;

  for (const r of recipients) {
    let shared: ExclusionReason | null = null;
    if (actorId && r.id === actorId) shared = "sender";
    else if (r.isSuspended) shared = "suspended";
    else if (r.anonymisedAt) shared = "anonymised";
    else if (marketing && !r.marketingConsentAt) shared = "no_marketing_consent";
    else if (marketing && capped.has(r.id)) shared = "frequency_capped";
    else if (marketing && conflicted.has(r.id)) shared = "automation_conflict";

    const d: Record<SingleChannel, ExclusionReason | null> = {
      in_app: shared,
      push: shared ?? (!hasToken.has(r.id) ? "no_push_token" : quietHours ? "quiet_hours" : null),
      email: shared ?? (!r.email || !r.email.includes("@") ? "no_email" : null),
    };
    decisions.set(r.id, d);
    for (const ch of ["in_app", "push", "email"] as SingleChannel[]) {
      const reason = d[ch];
      if (reason === null) channels[ch].eligible += 1;
      else channels[ch].excluded[reason] = (channels[ch].excluded[reason] ?? 0) + 1;
    }
    if (selected.some((ch) => d[ch] === null)) reachable += 1;
  }

  return {
    total: recipients.length,
    capped: recipients.length >= AUDIENCE_CAP && !isIndividualAudience(input.audience),
    category: input.category,
    quietHours,
    channels,
    reachable,
    recipients,
    decisions,
  };
}

function summarise(e: Evaluated): AudienceEvaluation {
  const { recipients: _r, decisions: _d, ...rest } = e;
  return rest;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      try {
        await fn(item);
      } catch (error) {
        logger.warn("Broadcast worker error (non-blocking)", { errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  await Promise.all(workers);
}

function inputFromRecord(b: {
  audience: string; audienceParams: unknown; channels: string[]; title: string; body: string;
  category: string; deepLink: string | null; templateKey: string | null;
}): AdminBroadcastInput {
  const params = (b.audienceParams ?? {}) as { vendorId?: string; userId?: string; productId?: string };
  return normalizeInput({
    audience: b.audience, channels: b.channels, subject: b.title, body: b.body,
    category: b.category, deepLink: b.deepLink ?? undefined, templateKey: b.templateKey ?? undefined,
    vendorId: params.vendorId, userId: params.userId, productId: params.productId,
  });
}

export function audienceParamsOf(input: AdminBroadcastInput): Prisma.InputJsonValue {
  return { vendorId: input.vendorId ?? null, userId: input.userId ?? null, productId: input.productId ?? null };
}

export interface BroadcastCounts {
  eligible: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  /** In-app only: notifications the recipient has opened. */
  read?: number;
}

async function countsFor(broadcastIds: string[]): Promise<Map<string, Record<string, BroadcastCounts>>> {
  const out = new Map<string, Record<string, BroadcastCounts>>();
  if (broadcastIds.length === 0) return out;
  const rows = await prisma.communicationLog.groupBy({
    by: ["broadcastId", "channel", "status"],
    where: { broadcastId: { in: broadcastIds } },
    _count: { id: true },
  });
  for (const row of rows) {
    if (!row.broadcastId) continue;
    const perChannel = out.get(row.broadcastId) ?? {};
    const c = perChannel[row.channel] ?? { eligible: 0, queued: 0, sent: 0, delivered: 0, failed: 0 };
    const n = row._count.id;
    c.eligible += n;
    if (row.status === "QUEUED") c.queued += n;
    else if (row.status === "SENT") c.sent += n;
    else if (row.status === "DELIVERED") c.delivered += n;
    else if (row.status === "FAILED") c.failed += n;
    perChannel[row.channel] = c;
    out.set(row.broadcastId, perChannel);
  }
  return out;
}

function statusFromCounts(perChannel: Record<string, BroadcastCounts>): { status: BroadcastStatus; attempted: number; failed: number } {
  let attempted = 0;
  let failed = 0;
  for (const c of Object.values(perChannel)) { attempted += c.eligible; failed += c.failed; }
  const status = attempted === 0 || failed === attempted
    ? BroadcastStatus.FAILED
    : failed > 0 ? BroadcastStatus.PARTIALLY_DELIVERED : BroadcastStatus.SENT;
  return { status, attempted, failed };
}

// ─── Public service ─────────────────────────────────────────────────────────

export interface BroadcastOptions {
  reason: string;
  idempotencyKey?: string;
  testToken?: string;
}

export const adminCommunicationsService = {
  normalizeInput,
  contentHash(input: AdminBroadcastInput): string {
    return broadcastContentHash({
      subject: input.subject, body: input.body, channels: selectedChannels(input),
      deepLink: input.deepLink, category: input.category,
    });
  },

  /** Which channels can be used right now, and why not (handbook 6.2 "Channel"). */
  async channelStatus() {
    const [tokenUsers, totalUsers, pause] = await Promise.all([
      prisma.pushToken.findMany({ distinct: ["userId"], select: { userId: true } }).then((r) => r.length),
      prisma.user.count({ where: { role: { in: [UserRole.BUYER, UserRole.VENDOR] }, anonymisedAt: null } }),
      commsPauseService.getState(),
    ]);
    const emailOn = isEmailEnabled();
    return {
      in_app: { configured: true, provider: "Eki in-app notifications", note: "Always available." },
      push: {
        configured: true,
        provider: "Expo Push Service (relays to APNs for iOS and FCM for Android)",
        tokenUsers,
        totalUsers,
        coveragePct: totalUsers > 0 ? Math.round((tokenUsers / totalUsers) * 1000) / 10 : 0,
        expoAccessToken: Boolean(process.env.EXPO_ACCESS_TOKEN),
        note: "SENT means handed to Expo. Delivered is only recorded when Expo returns a successful receipt.",
      },
      email: {
        configured: emailOn,
        provider: "Resend",
        note: emailOn ? "Accepted by Resend is recorded as Sent; inbox delivery is not tracked." : "Email provider is not configured (RESEND_API_KEY missing). Email cannot be sent.",
      },
      sms: { available: false, note: "SMS is not offered." },
      pause,
      deepLinks: ALLOWED_DEEP_LINKS,
      frequencyCapHours: BROADCAST_FREQUENCY_CAP_HOURS,
      quietHoursUtc: { start: 22, end: 7 },
      audienceCap: AUDIENCE_CAP,
    };
  },

  /** Exact eligible/excluded counts per channel, from the same engine the send uses. */
  async previewAudience(
    input: AudienceSelector & { category?: BroadcastCategory; wantsInApp?: boolean; wantsPush?: boolean; wantsEmail?: boolean },
    actorId: string | null = null,
  ): Promise<{ audienceCount: number } & AudienceEvaluation> {
    const category = input.category ?? (isIndividualAudience(input.audience) ? "operational" : "marketing");
    const selected = selectedChannels({
      wantsInApp: input.wantsInApp ?? true, wantsPush: input.wantsPush ?? true, wantsEmail: input.wantsEmail ?? true,
    });
    const evaluated = await evaluateAudience({ ...input, category }, actorId, selected);
    return { audienceCount: evaluated.total, ...summarise(evaluated) };
  },

  /** Per-channel render of what the recipient will see (handbook "Preview"). */
  preview(input: AdminBroadcastInput, sample: { name?: string; store_name?: string } = {}) {
    const title = renderVariables(input.subject, sample);
    const body = renderVariables(input.body, sample);
    const extras = input.category === "marketing" ? marketingEmailExtras("preview-user") : null;
    const email = emailTemplates.adminBroadcast({ subject: title, body, footerHtml: extras?.footerHtml });
    return {
      push: { title, body },
      in_app: { title, body, deepLink: input.deepLink ?? null },
      email: { subject: email.subject, html: email.html, unsubscribe: Boolean(extras) },
    };
  },

  /**
   * Real test-send to the requesting admin only, through the same channel code.
   * Returns a per-channel result and — only when EVERY selected channel worked —
   * a signed proof the Send button needs.
   */
  async testSend(actorId: string, input: AdminBroadcastInput) {
    const admin = await prisma.user.findUnique({ where: { id: actorId }, select: RECIPIENT_SELECT });
    if (!admin) throw new AppError("Admin account not found", 404);

    const channels = selectedChannels(input);
    const results: Partial<Record<SingleChannel, { ok: boolean; status: string; detail?: string }>> = {};
    const sample = { name: admin.name, store_name: admin.vendor?.storeName };
    const title = `[TEST] ${renderVariables(input.subject, sample)}`;
    const body = renderVariables(input.body, sample);
    const link = input.deepLink;

    if (input.wantsInApp) {
      try {
        await prisma.notification.create({
          data: {
            userId: admin.id,
            type: NotificationType.ADMIN_BROADCAST,
            title,
            body,
            data: { source: "admin_test_send", type: "admin_broadcast", ...(link ? { link } : {}) },
          },
        });
        results.in_app = { ok: true, status: "created", detail: "Added to your in-app inbox." };
      } catch (error) {
        results.in_app = { ok: false, status: "failed", detail: error instanceof Error ? error.message : String(error) };
      }
    }
    if (input.wantsPush) {
      const r = await sendPushToUser(admin.id, { title, body, data: { type: "admin_broadcast_test", ...(link ? { link } : {}) } });
      results.push = r.tokens === 0
        ? { ok: false, status: "no_device", detail: "Your admin account has no registered device. Log in on the mobile app with this account to receive push tests." }
        : r.accepted > 0
          ? { ok: true, status: "handed_to_expo", detail: `Handed to Expo for ${r.accepted} device(s). Check your phone.` }
          : { ok: false, status: "rejected", detail: r.error ?? "Expo rejected the message" };
    }
    if (input.wantsEmail) {
      if (!isEmailEnabled()) {
        results.email = { ok: false, status: "not_configured", detail: "Email provider is not configured; cannot send." };
      } else {
        const extras = input.category === "marketing" ? marketingEmailExtras(admin.id) : null;
        const tpl = emailTemplates.adminBroadcast({ subject: title, body, footerHtml: extras?.footerHtml });
        const r = await sendEmailDetailed({ to: admin.email, subject: tpl.subject, html: tpl.html, headers: extras?.headers });
        results.email = r.ok
          ? { ok: true, status: "accepted_by_provider", detail: `Accepted by Resend for ${admin.email}.` }
          : { ok: false, status: "failed", detail: r.error };
      }
    }

    const passed = channels.length > 0 && channels.every((ch) => results[ch]?.ok);
    const testToken = passed ? signTestToken(actorId, adminCommunicationsService.contentHash(input)) : undefined;
    return { sentTo: admin.email, channels, results, passed, testToken };
  },

  assertTestPassed(actorId: string, input: AdminBroadcastInput, token: unknown): void {
    if (!verifyTestToken(token, actorId, adminCommunicationsService.contentHash(input))) {
      throw new AppError(
        "Send a successful test to yourself with this exact content before sending. Changing the content or channels requires a new test.",
        409, undefined, "TEST_SEND_REQUIRED",
      );
    }
  },

  /**
   * Immediate broadcast. Creates the Broadcast row first (unique idempotency key
   * => a retry/double click returns the existing broadcast and never re-sends),
   * then delivers.
   */
  async broadcast(actorId: string, input: AdminBroadcastInput, opts: BroadcastOptions) {
    if (await commsPauseService.isCommsPaused()) {
      throw new AppError("Outbound communications are paused (emergency pause). Resume them from the Communications page.", 409, undefined, "COMMS_PAUSED");
    }
    const reason = (opts.reason ?? "").trim();
    if (reason.length < 5) throw new AppError("A purpose/reason of at least 5 characters is required", 400);

    if (opts.idempotencyKey) {
      const existing = await prisma.broadcast.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
      if (existing) return { duplicate: true as const, ...(await adminCommunicationsService.getBroadcast(existing.id)) };
    }

    let broadcastId: string;
    try {
      const created = await prisma.broadcast.create({
        data: {
          createdById: actorId,
          status: BroadcastStatus.SENDING,
          category: input.category,
          title: input.subject,
          body: input.body,
          deepLink: input.deepLink ?? null,
          templateKey: input.templateKey ?? null,
          audience: input.audience,
          audienceParams: audienceParamsOf(input),
          channels: selectedChannels(input),
          reason,
          idempotencyKey: opts.idempotencyKey ?? null,
          startedAt: new Date(),
        },
      });
      broadcastId = created.id;
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002" && opts.idempotencyKey) {
        const existing = await prisma.broadcast.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
        if (existing) return { duplicate: true as const, ...(await adminCommunicationsService.getBroadcast(existing.id)) };
      }
      throw error;
    }

    await adminCommunicationsService.executeBroadcast(broadcastId);
    return { duplicate: false as const, ...(await adminCommunicationsService.getBroadcast(broadcastId)) };
  },

  /**
   * Delivers a Broadcast that is already claimed (status SENDING). Used by the
   * immediate path and the scheduled runner. Never double-sends: callers claim
   * the row first.
   */
  async executeBroadcast(broadcastId: string): Promise<{ status: BroadcastStatus }> {
    const b = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    if (!b) throw new AppError("Broadcast not found", 404);
    const input = inputFromRecord(b);
    const channels = selectedChannels(input);
    const actorId = b.createdById;
    const evaluated = await evaluateAudience(input, actorId, channels);

    const emailConfigured = isEmailEnabled();
    const channelResults: Record<string, string> = {};
    if (input.wantsEmail && !emailConfigured) channelResults.email = "not_configured";
    if (input.wantsPush && evaluated.quietHours) channelResults.push_quiet_hours = "marketing push excluded during quiet hours (22:00-07:00 UTC)";

    const eventKey = input.category === "marketing" ? MARKETING_EVENT_KEY : OPERATIONAL_EVENT_KEY;
    const recipientType = (r: BroadcastRecipient) => (r.role === UserRole.VENDOR ? "VENDOR" : "BUYER");

    // Build per-recipient work + QUEUED log rows up front (ids pre-generated so
    // the push/email result can be written back to the exact row).
    type Work = { logId: string; recipient: BroadcastRecipient; channel: SingleChannel; title: string; body: string };
    const work: Work[] = [];
    for (const r of evaluated.recipients) {
      const d = evaluated.decisions.get(r.id)!;
      const vars = { name: r.name, store_name: r.vendor?.storeName };
      const title = renderVariables(input.subject, vars);
      const body = renderVariables(input.body, vars);
      for (const ch of channels) {
        if (d[ch] !== null) continue;
        if (ch === "email" && !emailConfigured) continue;
        work.push({ logId: randomUUID(), recipient: r, channel: ch, title, body });
      }
    }

    const CHUNK = 500;
    for (let i = 0; i < work.length; i += CHUNK) {
      await prisma.communicationLog.createMany({
        data: work.slice(i, i + CHUNK).map((w) => ({
          id: w.logId,
          recipientId: w.recipient.id,
          recipientType: recipientType(w.recipient),
          eventKey,
          channel: w.channel,
          title: w.title,
          body: w.body,
          status: "QUEUED",
          broadcastId,
          metadata: { category: input.category, audience: input.audience } as Prisma.InputJsonValue,
        })),
      });
    }

    const workById = new Map(work.map((w) => [w.logId, w]));
    const setLog = (id: string, status: string, detail?: string, providerRef?: string) =>
      prisma.communicationLog.update({ where: { id }, data: { status, statusDetail: detail ?? null, providerRef: providerRef ?? null } })
        .then(() => {
          // Canonical message event for the real outcome. SENT in-app = stored in the inbox (delivered);
          // SENT push/email = accepted by Expo/the mail provider (queued; push receipts later emit delivered).
          const w = workById.get(id);
          if (!w) return;
          const outcome = status === "FAILED" ? "failed" : w.channel === "in_app" ? "delivered" : "queued";
          emitMessageEvent(outcome, { logId: id, recipientId: w.recipient.id, channel: w.channel, eventKey, broadcastId, detail, source: "admin_broadcast" });
        })
        .catch((error) => {
          logger.warn("Could not update communication log", { id, errorMessage: error instanceof Error ? error.message : String(error) });
        });

    const link = input.deepLink;
    const individual = isIndividualAudience(input.audience);

    // in-app
    await mapLimit(work.filter((w) => w.channel === "in_app"), SEND_CONCURRENCY, async (w) => {
      try {
        await prisma.notification.create({
          data: {
            userId: w.recipient.id,
            type: NotificationType.ADMIN_BROADCAST,
            title: w.title,
            body: w.body,
            data: { source: "admin", type: "admin_broadcast", broadcastId, category: input.category, ...(link ? { link } : {}) },
          },
        });
        if (individual) {
          // Individual messages also open an admin conversation so the person can reply.
          const [a, bId] = actorId < w.recipient.id ? [actorId, w.recipient.id] : [w.recipient.id, actorId];
          const conv = await prisma.conversation.upsert({
            where: { participantA_participantB_orderId: { participantA: a, participantB: bId, orderId: "" } },
            create: { participantA: a, participantB: bId, orderId: "", type: w.recipient.role === UserRole.VENDOR ? "ADMIN_VENDOR" : "BUYER_VENDOR", lastMessageAt: new Date() },
            update: { lastMessageAt: new Date() },
          });
          await prisma.message.create({ data: { conversationId: conv.id, senderId: actorId, text: `${w.title}\n\n${w.body}` } });
        }
        await setLog(w.logId, "SENT", "stored_in_inbox");
      } catch (error) {
        await setLog(w.logId, "FAILED", error instanceof Error ? error.message : String(error));
      }
    });

    // push
    await mapLimit(work.filter((w) => w.channel === "push"), SEND_CONCURRENCY, async (w) => {
      const r = await sendPushToUser(
        w.recipient.id,
        { title: w.title, body: w.body, data: { type: "admin_broadcast", broadcastId, ...(link ? { link } : {}) } },
        { logId: w.logId },
      );
      if (r.accepted > 0) await setLog(w.logId, "SENT", "handed_to_expo", r.ticketIds[0]);
      else await setLog(w.logId, "FAILED", r.tokens === 0 ? "no_push_token" : (r.error ?? "expo_rejected"));
    });

    // email
    await mapLimit(work.filter((w) => w.channel === "email"), SEND_CONCURRENCY, async (w) => {
      const extras = input.category === "marketing" ? marketingEmailExtras(w.recipient.id) : null;
      const tpl = emailTemplates.adminBroadcast({ subject: w.title, body: w.body, footerHtml: extras?.footerHtml });
      const r = await sendEmailDetailed({ to: w.recipient.email, subject: tpl.subject, html: tpl.html, headers: extras?.headers });
      if (r.ok) await setLog(w.logId, "SENT", "accepted_by_provider", r.id);
      else await setLog(w.logId, "FAILED", r.error ?? "email_failed");
    });

    const counts = (await countsFor([broadcastId])).get(broadcastId) ?? {};
    const { status, attempted } = statusFromCounts(counts);
    let error: string | null = null;
    if (attempted === 0) {
      error = input.wantsEmail && !emailConfigured && channels.length === 1
        ? "Email provider is not configured; nothing was sent."
        : "No eligible recipients on the selected channels; nothing was sent.";
    }
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status,
        completedAt: new Date(),
        audienceTotal: evaluated.total,
        eligibility: summarise(evaluated) as unknown as Prisma.InputJsonValue,
        channelResults: channelResults as Prisma.InputJsonValue,
        error,
      },
    });
    return { status };
  },

  /** Broadcast + live per-channel counts (queued/sent/delivered/failed, plus in-app read). */
  async getBroadcast(id: string) {
    const b = await prisma.broadcast.findUnique({ where: { id } });
    if (!b) throw new AppError("Broadcast not found", 404);
    const counts = (await countsFor([id])).get(id) ?? {};
    if (counts.in_app) {
      counts.in_app.read = await prisma.notification.count({
        where: { data: { path: ["broadcastId"], equals: id }, readAt: { not: null } },
      }).catch(() => 0);
    }
    return { broadcast: b, counts };
  },

  async listBroadcasts(query: { status?: string; limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const where: Prisma.BroadcastWhereInput = {};
    if (query.status && (Object.values(BroadcastStatus) as string[]).includes(query.status)) {
      where.status = query.status as BroadcastStatus;
    }
    const rows = await prisma.broadcast.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const counts = await countsFor(page.map((b) => b.id));
    const creators = await prisma.user.findMany({
      where: { id: { in: [...new Set(page.map((b) => b.createdById))] } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(creators.map((c) => [c.id, c]));
    return {
      items: page.map((b) => ({ ...b, counts: counts.get(b.id) ?? {}, createdBy: byId.get(b.createdById) ?? null })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  },

  /** Recompute final status after late push receipts (delivered/failed). */
  async reconcileRecentBroadcasts(): Promise<{ checked: number; changed: number }> {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recent = await prisma.broadcast.findMany({
      where: { status: { in: [BroadcastStatus.SENT, BroadcastStatus.PARTIALLY_DELIVERED] }, completedAt: { gte: since } },
      select: { id: true, status: true },
    });
    const counts = await countsFor(recent.map((b) => b.id));
    let changed = 0;
    for (const b of recent) {
      const { status } = statusFromCounts(counts.get(b.id) ?? {});
      if (status !== b.status && status !== BroadcastStatus.FAILED) {
        await prisma.broadcast.update({ where: { id: b.id }, data: { status } });
        changed += 1;
      }
    }
    return { checked: recent.length, changed };
  },

  /** Pulls real Expo receipts for one broadcast's push tickets now, then refreshes status. */
  async refreshReceipts(id: string) {
    const logs = await prisma.communicationLog.findMany({
      where: { broadcastId: id, channel: "push", status: "SENT" },
      select: { id: true },
    });
    const receipts = logs.length > 0
      ? await checkPushReceipts({ logIds: logs.map((l) => l.id), ignoreDelay: false })
      : { checked: 0, invalidated: 0, errors: 0 };
    await adminCommunicationsService.reconcileRecentBroadcasts();
    return { receipts, ...(await adminCommunicationsService.getBroadcast(id)) };
  },

  /** Picker for individual recipients (search by name / email / store, or by id for deep links). */
  async searchRecipients(query: { q?: string; id?: string }) {
    const where: Prisma.UserWhereInput = { role: { in: [UserRole.BUYER, UserRole.VENDOR] }, anonymisedAt: null };
    if (query.id) where.id = query.id;
    else if (query.q && query.q.trim().length >= 2) {
      const q = query.q.trim();
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { vendor: { storeName: { contains: q, mode: "insensitive" } } },
      ];
    } else {
      return { users: [] };
    }
    const users = await prisma.user.findMany({
      where,
      take: 10,
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true, isSuspended: true, marketingConsentAt: true, vendor: { select: { id: true, storeName: true } } },
    });
    return { users };
  },
};

export { PAUSE_REASON };
