import crypto from "crypto";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { automationService } from "./automation.service";
import { getRuleGate, noteRuleSkipped } from "./automation-rule-gate";
import { eventsService, EVENT_NAMES } from "../events/events.service";
import { runWithCoalesceScope } from "./automation-coalesce-scope";
import { detectVendorTrialEnding } from "./vendor-trial-ending";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoWeek(d: Date): string {
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - onejan.getTime()) / DAY_MS + onejan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

export const FIRST_SALE_PAID_STATUSES = ["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED", "PAYMENT_SECURED", "VENDOR_CONFIRMED", "AUTO_RELEASED", "DISPUTED"] as const;

// Notification Orchestration Spec v2 (2026-10-25), section 6: P2 "task
// recovery" cadence is 4h / 24h / 72h after inactivity, maximum three sends
// per unresolved episode — then silence (no indefinite weekly fallback;
// the spec is explicit about the cap). Shared by every R01/R03/R05/R06
// vendor-onboarding rule below.
//
// Honesty note on timing: this backend's only trigger is the Vercel cron
// in vercel.json, currently once/day. A daily cron cannot deliver a true
// "4 hours after inactivity" first touch — by the time it next runs, more
// than 4h has usually already passed. The logic below is written to be
// correct at ANY cron frequency: each call attempts every threshold whose
// time has already passed (not just the "nearest" one), and the DB-unique
// dedupeKey per threshold makes an already-sent touch a harmless no-op on
// re-attempt. So touch timing will track the spec exactly once the cron
// runs at least every few minutes; with today's once-daily cron it
// degrades to "each threshold fires on the first daily check after it's
// crossed" — still bounded to 3 sends, still correct, just coarser than
// spec until the cron frequency changes (needs a Vercel plan that allows
// more than one cron run per day).
const P2_TOUCH_HOURS = [4, 24, 72] as const;
const HOUR_MS = 60 * 60 * 1000;

/** Every P2 touch number (1-based) whose threshold has already passed. */
function duePTouchNumbers(hoursSinceEligible: number): number[] {
  const due: number[] = [];
  for (let i = 0; i < P2_TOUCH_HOURS.length; i++) {
    if (hoursSinceEligible >= P2_TOUCH_HOURS[i]) due.push(i + 1);
  }
  return due;
}

/**
 * Fires every P2 touch (up to 3) whose threshold has passed for one
 * candidate, each as its own automationService.scheduleAutomation call
 * with its own `:touchN` dedupeKey — see duePTouchNumbers' doc comment on
 * why "attempt all due, let dedupe no-op the already-sent ones" is correct
 * regardless of cron frequency.
 */
async function scheduleP2Touches(input: {
  type: Parameters<typeof automationService.scheduleAutomation>[0]["type"];
  recipientUserId: string;
  vendorId?: string;
  subjectPrefix: string;
  hoursSinceEligible: number;
  requiresMarketingConsent: boolean;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<number> {
  const dueTouchNumbers = duePTouchNumbers(input.hoursSinceEligible);
  if (dueTouchNumbers.length === 0) return 0;

  // Bug fix 2026-10-29 (found via production evidence — a vendor's own
  // AutomationRun history showed touch2/touch3 had NEVER once been sent,
  // on any day, for any recipient): once touch1 has actually SENT, it
  // becomes a PERMANENT dedupeKey — every later sweep still re-attempts
  // it (hoursSinceEligible only grows), and isEligible() claims this
  // recipient's one-per-sweep non-urgent coalescing slot BEFORE the
  // attempt fails on the dedupeKey's unique constraint. That pointless
  // re-attempt of an already-delivered touch was winning the slot every
  // single day, forever, so touch2 (24h) and touch3 (72h) could never
  // get a turn — "coalesced_same_run" masquerading as working as
  // designed. Fix: look up which of the due touches already have a real
  // SENT row first, and only ever attempt the ones that don't — an
  // already-sent touch no longer competes for the coalescing slot at all.
  const candidateKeys = dueTouchNumbers.map((n) => `${input.type}:${input.subjectPrefix}:touch${n}`);
  const alreadySent = await automationService.listSentDedupeKeys(candidateKeys);
  const touchesToAttempt = dueTouchNumbers.filter((n) => !alreadySent.has(`${input.type}:${input.subjectPrefix}:touch${n}`));
  if (touchesToAttempt.length === 0) return 0;

  let scheduled = 0;
  for (const touchNumber of touchesToAttempt) {
    await automationService.scheduleAutomation({
      type: input.type,
      recipientUserId: input.recipientUserId,
      vendorId: input.vendorId,
      subjectKey: `${input.subjectPrefix}:touch${touchNumber}`,
      requiresMarketingConsent: input.requiresMarketingConsent,
      title: input.title,
      body: input.body,
      data: { ...input.data, touch_number: touchNumber },
    });
    scheduled++;
  }
  return scheduled;
}

/**
 * REGISTRATION_REMINDER (spec R01): nudges a VENDOR-role account that
 * never finished creating its Vendor profile (storeName/storeSlug etc. via
 * POST /vendors — vendors.service.ts createVendor), at 4h/24h/72h since
 * the account was created (see P2_TOUCH_HOURS above).
 *
 * NOT based on email verification, despite the type's original name —
 * verified by inspection (2026-10-23) to be the wrong signal for "finished
 * registration" in this codebase: register()/oauth completeSignup create
 * an EmailVerificationToken row, but NOTHING ever emails that token (no
 * `enqueueEmail` call references it anywhere in src/modules/auth), and
 * neither the web nor the mobile app has any verify-email screen or deep
 * link that calls POST /auth/verify-email — it is unreachable dead
 * scaffolding today. Nudging a user to "verify your email" would point at
 * an action they have no way to complete. Fixing email delivery for that
 * flow is a separate, real gap, still out of scope here.
 *
 * A VENDOR with no Vendor row is otherwise invisible to every other
 * onboarding automation (FIRST_PRODUCT_REMINDER/DELIVERY_SETUP_REMINDER/
 * VERIFICATION_REMINDER/FIRST_SALE all query `prisma.vendor.findMany`,
 * which only ever sees vendors who already have a Vendor row). This is the
 * actual gap matching the client's report.
 *
 * BUYER-role accounts have no further "registration" step in this
 * codebase, so they are not candidates here — this also naturally excludes
 * guest-checkout and supplier-invite-accepted accounts (both role BUYER).
 *
 * Self-cancelling: the candidate query excludes any VENDOR who already has
 * a Vendor row.
 */
async function detectRegistrationReminder(): Promise<number> {
  const cutoff = new Date(Date.now() - P2_TOUCH_HOURS[P2_TOUCH_HOURS.length - 1] * HOUR_MS - DAY_MS);
  const users = await prisma.user.findMany({
    where: {
      role: "VENDOR",
      vendor: null,
      isSuspended: false,
      isTest: false,
      createdAt: { gte: cutoff },
    },
    select: { id: true, createdAt: true },
    take: 500,
  });

  let scheduled = 0;
  for (const user of users) {
    const hoursSinceCreated = (Date.now() - user.createdAt.getTime()) / HOUR_MS;
    scheduled += await scheduleP2Touches({
      type: "REGISTRATION_REMINDER",
      recipientUserId: user.id,
      // No Vendor row exists yet — this is the whole point of the rule — so vendorId is omitted.
      subjectPrefix: user.id,
      hoursSinceEligible: hoursSinceCreated,
      requiresMarketingConsent: false,
      title: "Start setting up your Eki store",
      body: "Add your business details to begin.",
    });
  }
  return scheduled;
}

/**
 * Shared candidate query for the three vendor-store-progress rules
 * (R03/R05/R06): every unsuspended, non-test vendor who hasn't sold
 * anything yet, with product count and delivery-zone presence attached.
 * Mirrors FIRST_SALE's old merged candidate query exactly — only the
 * per-rule stage check and copy differ now.
 */
async function loadOnboardingProgressCandidates() {
  const vendors = await prisma.vendor.findMany({
    where: {
      isSuspended: false,
      orderItems: { none: { order: { status: { in: [...FIRST_SALE_PAID_STATUSES] } } } },
    },
    select: {
      id: true, userId: true, storeName: true, verificationStatus: true, stripeVerificationSessionId: true, createdAt: true,
      _count: { select: { products: { where: { isActive: true } } } },
    },
    take: 200,
  });
  const zoneCounts = vendors.length
    ? await prisma.deliveryZone.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendors.map((v) => v.id) } }, _count: { _all: true } })
    : [];
  const hasDeliveryZone = new Set(zoneCounts.filter((z) => z._count._all > 0).map((z) => z.vendorId));
  return vendors.map((v) => ({
    ...v,
    hasProduct: v._count.products > 0,
    hasDelivery: hasDeliveryZone.has(v.id),
    isVerified: v.verificationStatus === "VERIFIED",
    hasVerificationSession: Boolean(v.stripeVerificationSessionId),
  }));
}

/**
 * FIRST_PRODUCT_REMINDER (spec R03): "Store ready, zero foodstuff."
 * Candidates: has a Vendor row, no active products yet. Stops the moment
 * the first active product exists.
 */
async function detectFirstProductReminder(): Promise<number> {
  const candidates = await loadOnboardingProgressCandidates();
  let scheduled = 0;
  for (const vendor of candidates) {
    if (vendor.hasProduct) continue;
    const hoursSinceCreated = (Date.now() - vendor.createdAt.getTime()) / HOUR_MS;
    scheduled += await scheduleP2Touches({
      type: "FIRST_PRODUCT_REMINDER",
      recipientUserId: vendor.userId,
      vendorId: vendor.id,
      subjectPrefix: vendor.id,
      hoursSinceEligible: hoursSinceCreated,
      requiresMarketingConsent: false,
      title: "Add your first foodstuff",
      body: "Start with the foodstuff your buyers ask for most.",
      data: { store_name: vendor.storeName },
    });
  }
  return scheduled;
}

/**
 * DRAFT_PRODUCT_REMINDER (R04): remind the owner of an actually incomplete
 * Product draft. `Product.status` alone is insufficient because complete
 * products can deliberately remain unpublished; use the same completeness
 * predicate as products.service (images.length > 0 && priceInCents > 0).
 * The draft's updatedAt is the inactivity clock, so saving meaningful edits
 * restarts the P2 window. A completed draft or any transition out of DRAFT
 * is excluded on the next sweep. Copy follows v2; new rule records stay
 * DRAFT while Acquisition WhatsApp ownership, sub-daily timing, and live
 * route delivery remain unverified.
 */
async function detectDraftProductReminder(): Promise<number> {
  const gate = await getRuleGate("DRAFT_PRODUCT_REMINDER");
  if (gate.state !== "ACTIVE") return 0;

  const drafts = await prisma.product.findMany({
    where: { status: "DRAFT", isActive: false, vendor: { isSuspended: false, isTest: false } },
    select: {
      id: true,
      vendorId: true,
      title: true,
      images: true,
      priceInCents: true,
      updatedAt: true,
      vendor: { select: { userId: true, storeName: true } },
    },
    take: 500,
  });

  let scheduled = 0;
  for (const product of drafts) {
    const complete = (product.images?.length ?? 0) > 0 && product.priceInCents > 0;
    if (complete) continue;
    const hoursSinceUpdate = (Date.now() - product.updatedAt.getTime()) / HOUR_MS;
    scheduled += await scheduleP2Touches({
      type: "DRAFT_PRODUCT_REMINDER",
      recipientUserId: product.vendor.userId,
      vendorId: product.vendorId,
      subjectPrefix: product.id,
      hoursSinceEligible: hoursSinceUpdate,
      requiresMarketingConsent: false,
      title: "Your foodstuff listing is nearly ready",
      body: "Finish the remaining details.",
      data: {
        destination: "foodstuff_editor",
        productId: product.id,
        product_title: product.title,
        store_name: product.vendor.storeName,
      },
    });
  }
  return scheduled;
}

/**
 * DELIVERY_SETUP_REMINDER (spec R05): "Delivery setup missing." Candidates:
 * has at least one active product, no DeliveryZone yet. Stops once a
 * delivery zone exists.
 */
async function detectDeliverySetupReminder(): Promise<number> {
  const candidates = await loadOnboardingProgressCandidates();
  let scheduled = 0;
  for (const vendor of candidates) {
    if (!vendor.hasProduct || vendor.hasDelivery) continue;
    const hoursSinceCreated = (Date.now() - vendor.createdAt.getTime()) / HOUR_MS;
    scheduled += await scheduleP2Touches({
      type: "DELIVERY_SETUP_REMINDER",
      recipientUserId: vendor.userId,
      vendorId: vendor.id,
      subjectPrefix: vendor.id,
      hoursSinceEligible: hoursSinceCreated,
      requiresMarketingConsent: false,
      title: "Set up how buyers receive your foodstuff",
      body: "Add delivery or collection options.",
      data: { store_name: vendor.storeName },
    });
  }
  return scheduled;
}

/**
 * VERIFICATION_REMINDER (spec R06): "Verification not started when
 * eligible." Candidates: has a product AND a delivery zone (the spec's
 * "when eligible" — verification only matters once there's something to
 * sell and somewhere to send it), not yet VERIFIED. Stops when a Stripe
 * Identity session ID exists: createStripeVerificationSession persists it
 * before returning the hosted verification flow, so subsequent reminders
 * do not continue after the vendor has started/submitted verification.
 */
async function detectVerificationReminder(): Promise<number> {
  const candidates = await loadOnboardingProgressCandidates();
  let scheduled = 0;
  for (const vendor of candidates) {
    if (!vendor.hasProduct || !vendor.hasDelivery || vendor.isVerified || vendor.hasVerificationSession) continue;
    const hoursSinceCreated = (Date.now() - vendor.createdAt.getTime()) / HOUR_MS;
    scheduled += await scheduleP2Touches({
      type: "VERIFICATION_REMINDER",
      recipientUserId: vendor.userId,
      vendorId: vendor.id,
      subjectPrefix: vendor.id,
      hoursSinceEligible: hoursSinceCreated,
      requiresMarketingConsent: false,
      title: "Your store is close to opening",
      body: "Complete secure verification to continue.",
      data: { store_name: vendor.storeName },
    });
  }
  return scheduled;
}

/**
 * FIRST_SALE (spec R11 only, narrowed 2026-10-25 — R01/R03/R05/R06 are now
 * their own types above): "First Sale Campaign not started." Candidates:
 * product + delivery + verified, still zero paid orders. Stop condition
 * per spec is "campaign started," which this codebase has no separate
 * concept of — stops on first qualifying paid order instead, same
 * honestly-documented substitution as VERIFICATION_REMINDER above.
 */
async function detectFirstSale(): Promise<number> {
  const candidates = await loadOnboardingProgressCandidates();
  let scheduled = 0;
  for (const vendor of candidates) {
    if (!vendor.hasProduct || !vendor.hasDelivery || !vendor.isVerified) continue;
    const hoursSinceCreated = (Date.now() - vendor.createdAt.getTime()) / HOUR_MS;
    scheduled += await scheduleP2Touches({
      type: "FIRST_SALE",
      recipientUserId: vendor.userId,
      vendorId: vendor.id,
      subjectPrefix: vendor.id,
      hoursSinceEligible: hoursSinceCreated,
      requiresMarketingConsent: false,
      title: "Work towards your first order",
      body: "Open your First Sale Campaign for the next step.",
      data: { store_name: vendor.storeName },
    });
  }
  return scheduled;
}

// The exact moment this `store_shared`/readiness-timestamp fix shipped
// (2026-10-26). Used only to bound the `store_viewed` fallback below —
// see detectStoreShareReminder's doc comment for why it must not be a
// permanent substitute for the spec's real "store shared" stop condition.
const STORE_SHARED_SIGNAL_SHIPPED_AT = new Date("2026-10-26T00:00:00.000Z");

/**
 * STORE_SHARE_REMINDER (spec R10): "Store live, never shared." Migrated
 * 2026-10-25 from the pre-spec "handoff V-06 store.link.not.shared"
 * (vendor-milestone-notifications.service.ts runShareReminderSweep,
 * removed) onto the P2 cadence shared with R01/R03/R05/R06/R11.
 *
 * Deliberately does NOT reuse loadOnboardingProgressCandidates(): that
 * helper excludes any vendor who already has a paid order, which is the
 * right exclusion for R01/R03/R05/R06/R11 but wrong here — R10's stop
 * condition is "store shared," not "never sold." A vendor who already
 * made a sale through some other channel but whose store has still never
 * been shared is still a legitimate candidate.
 *
 * STOP CONDITION, corrected 2026-10-26 after compliance review:
 * - Primary, unbounded signal: a real `store_shared` event (added
 *   2026-10-25 — public-stores.service.ts recordEvent(), fired when
 *   share-store-link.tsx's Share sheet completes).
 * - Secondary, TIME-BOUNDED fallback: a `store_viewed` event that
 *   happened BEFORE STORE_SHARED_SIGNAL_SHIPPED_AT only. This grandfathers
 *   vendors who were already viewed before the real signal existed (so
 *   they don't get nagged forever for something that happened under the
 *   old, looser rule) — but a view that happens AFTER this fix shipped no
 *   longer silently satisfies "shared." Going forward, only a genuine
 *   `store_shared` event stops the reminder for anyone newly becoming
 *   eligible. This was a PERMANENT fallback before this review; restricted
 *   to a bounded grandfather clause now, per compliance review, since an
 *   indefinite "any view counts as shared" substitution never actually
 *   matched the spec's literal requirement.
 * - Mobile now posts `store_shared` only when React Native's native share
 *   API reports `Share.sharedAction`, and the backend verifies the caller
 *   owns the store. Copying a link or merely opening WhatsApp/SMS does not
 *   emit the event because neither proves a completed share.
 * - Native share-result behavior still needs device-level QA on both iOS
 *   and Android. This client-reported signal is not proof that a recipient
 *   received or opened the link.
 *
 * New in this migration: a vendor-facing opt-out
 * (VENDOR_TOGGLEABLE_AUTOMATION_TYPES) — gives the spec's stop condition
 * "store shared OR opt-out" its second half, which did not exist at all
 * in the previous implementation.
 *
 * CADENCE CLOCK, corrected 2026-10-26: previously vendor.createdAt (account
 * creation), which the spec calls "24h after publication" — account
 * creation is not publication. Product.publishedAt is the real publication
 * timestamp written by the publishing flows; combine it with the earliest
 * delivery-zone createdAt and use whichever is later, i.e. the actual moment
 * both conditions of "ready" first became true. If an active legacy product
 * has no publishedAt, the detector leaves that vendor unscheduled rather than
 * guessing publication time from createdAt. One known edge case remains: if
 * the vendor's ORIGINAL first product was later deactivated and a
 * different one created afterward, "earliest ACTIVE product" shifts
 * forward to the newer one, understating how long the vendor has actually
 * been ready. Accepted as a minor, documented imprecision rather than
 * adding a new schema column for an exact historical "first ever became
 * ready" timestamp — out of scope for this fix.
 */
async function detectStoreShareReminder(): Promise<number> {
  const vendors = await prisma.vendor.findMany({
    where: { isSuspended: false, products: { some: { isActive: true } } },
    select: { id: true, userId: true, storeName: true },
    take: 500,
  });
  if (vendors.length === 0) return 0;
  const vendorIds = vendors.map((v) => v.id);

  const [zoneCounts, firstZoneByVendor, firstProductByVendor] = await Promise.all([
    prisma.deliveryZone.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendorIds } }, _count: { _all: true } }),
    prisma.deliveryZone.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendorIds } }, _min: { createdAt: true } }),
    prisma.product.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendorIds }, isActive: true, publishedAt: { not: null } }, _min: { publishedAt: true } }),
  ]);
  const hasZone = new Set(zoneCounts.filter((z) => z._count._all > 0).map((z) => z.vendorId));
  const firstZoneAt = new Map(firstZoneByVendor.map((z) => [z.vendorId, z._min.createdAt]));
  const firstProductAt = new Map(firstProductByVendor.map((p) => [p.vendorId, p._min.publishedAt]));
  const readyVendors = vendors.filter((v) => hasZone.has(v.id));

  let scheduled = 0;
  for (const vendor of readyVendors) {
    const [sharedCount, viewedBeforeCutoffCount] = await Promise.all([
      prisma.event.count({ where: { name: "store_shared", entityType: "Vendor", entityId: vendor.id } }),
      prisma.event.count({ where: { name: "store_viewed", entityType: "Vendor", entityId: vendor.id, createdAt: { lt: STORE_SHARED_SIGNAL_SHIPPED_AT } } }),
    ]);
    if (sharedCount > 0 || viewedBeforeCutoffCount > 0) continue; // stop condition — see doc comment above.

    // "Ready since" = later of first published product / first delivery zone.
    // Product.createdAt can precede publication by days, so use the actual
    // publishedAt transition written by the product publishing flows.
    const zoneAt = firstZoneAt.get(vendor.id);
    const productAt = firstProductAt.get(vendor.id);
    if (!zoneAt || !productAt) continue; // defensive: readyVendors filter already guarantees both exist.
    const readySince = zoneAt.getTime() > productAt.getTime() ? zoneAt : productAt;
    const hoursSinceReady = (Date.now() - readySince.getTime()) / HOUR_MS;

    scheduled += await scheduleP2Touches({
      type: "STORE_SHARE_REMINDER",
      recipientUserId: vendor.userId,
      vendorId: vendor.id,
      subjectPrefix: vendor.id,
      hoursSinceEligible: hoursSinceReady,
      requiresMarketingConsent: false,
      title: "Share your store link",
      body: "Your store is ready for its next step. Share your store link with buyers.",
      data: { store_name: vendor.storeName },
    });
  }
  return scheduled;
}

/**
 * AUTOMATION_FAILURE_ALERT (spec R38): "An Eki automation needs
 * attention." Previously only admin-visible (automationRulesService.
 * failures(), the Automation Centre's own failure feed) — the spec wants
 * the VENDOR notified too, which did not exist at all before this.
 *
 * Looks back 24h over AutomationRun rows with status=FAILED, a real
 * vendorId (excludes REGISTRATION_REMINDER, which has none — nothing to
 * tell a non-existent vendor), isTest=false, and — critically — type !==
 * "AUTOMATION_FAILURE_ALERT" itself. That self-exclusion is the
 * notification-loop guard the spec explicitly calls for (section 4, R38
 * and R40): without it, if sending THIS alert ever failed, the next
 * sweep would see that failure too and schedule another alert about it,
 * which could fail the same way, forever.
 *
 * One alert per vendor per calendar day, regardless of how many of their
 * automations failed that day (dedupeKey `${vendorId}:${isoDate}`) — this
 * is a "something's wrong, go look" signal, not a per-failure escalating
 * nudge, so it doesn't use the P2 touch helper.
 *
 * Not vendor-toggleable (added to EKI_MANAGED_AUTOMATION_TYPES, not
 * VENDOR_TOGGLEABLE_AUTOMATION_TYPES) — the same reasoning as
 * PAYMENT_RECOVERY/RENEWAL_REMINDER/PRICE_APPROVAL_REMINDER: a vendor
 * should not be able to silence being told their own automations are
 * broken.
 */
async function detectAutomationFailureAlert(): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const failedRuns = await prisma.automationRun.findMany({
    where: {
      status: "FAILED",
      isTest: false,
      vendorId: { not: null },
      type: { not: "AUTOMATION_FAILURE_ALERT" },
      createdAt: { gte: since },
    },
    select: { vendorId: true },
    distinct: ["vendorId"],
  });
  if (failedRuns.length === 0) return 0;

  const vendorIds = failedRuns.map((r) => r.vendorId as string);
  const vendors = await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, userId: true, storeName: true } });

  const todayKey = new Date().toISOString().slice(0, 10);
  let scheduled = 0;
  for (const vendor of vendors) {
    await automationService.scheduleAutomation({
      type: "AUTOMATION_FAILURE_ALERT",
      recipientUserId: vendor.userId,
      vendorId: vendor.id,
      subjectKey: `${vendor.id}:${todayKey}`,
      requiresMarketingConsent: false,
      bypassQuietHours: true, // operational alert about their own account — same class as PAYMENT_RECOVERY.
      title: "An Eki automation needs attention",
      body: `${vendor.storeName ?? "Your store"} has an automation that failed to send. Review it and the next step.`,
      data: { store_name: vendor.storeName },
    });
    scheduled++;
  }
  return scheduled;
}

/**
 * CART_RECOVERY: items sitting in a buyer's cart past a per-vendor reminder
 * delay (default 2h, vendor-configurable via VendorAutomationSetting.config).
 * A cart can span multiple vendors' products, so it's evaluated once per
 * vendor represented in the cart, each against that vendor's own delay.
 *
 * Bounded to exactly two touches per cart+vendor (Eki requirements review,
 * 2026-10-22): a first reminder at `reminderHours` (default 2h) and one
 * final reminder at `secondReminderHours` (default 24h) — not an unbounded
 * daily repeat like the previous version. subjectKey has no date component
 * (`:first` / `:final` only), so each touch can only ever fire once per
 * cart+vendor; once both have fired, this cart+vendor goes quiet even if
 * the same items are still sitting there. Known, accepted limitation: this
 * is scoped to the cart+vendor pair, not the individual item, so a buyer
 * who empties a vendor's items and later adds different ones from the SAME
 * vendor to the SAME cart will not get a fresh pair of touches — re-keying
 * per item-batch would need a per-item dedupe scheme this table doesn't
 * have today, and is out of scope for this fix.
 *
 * Previously used `frequencyCapDays: 1` on top of the dedupe key, which
 * (see isEligible() in automation.service.ts) matches on type+recipient
 * ALONE — so a buyer with stale carts at two different vendors only ever
 * got a reminder for whichever vendor's check ran first in a given sweep;
 * the second vendor's reminder was wrongly suppressed as "frequency_capped"
 * for a full day. Dropped, same fix as FIRST_SALE's equivalent bug — the
 * per-touch dedupeKey is the only de-dupe needed.
 *
 * Availability recheck (spec: "recalculate product availability... before
 * generating any checkout link"): if every item this vendor has in the
 * cart is no longer purchasable (inactive or out of stock), the reminder
 * is skipped entirely rather than nudging someone to check out on items
 * that can't be bought.
 */
async function detectCartRecovery(): Promise<number> {
  const widestCutoff = new Date(Date.now() - 60 * 60 * 1000); // API enforces reminderHours >= 1, so this is a safe pre-filter floor.
  const carts = await prisma.cart.findMany({
    where: { items: { some: { createdAt: { lte: widestCutoff } } } },
    select: {
      id: true,
      buyerId: true,
      items: { select: { id: true, createdAt: true, product: { select: { vendorId: true, isActive: true, stock: true } } } },
    },
    take: 500,
  });

  const vendorConfigCache = new Map<string, { reminderHours: number; secondReminderHours: number }>();
  async function configFor(vendorId: string): Promise<{ reminderHours: number; secondReminderHours: number }> {
    if (!vendorConfigCache.has(vendorId)) {
      vendorConfigCache.set(vendorId, await automationService.getVendorAutomationConfig(vendorId, "CART_RECOVERY") as { reminderHours: number; secondReminderHours: number });
    }
    return vendorConfigCache.get(vendorId)!;
  }

  let scheduled = 0;
  for (const cart of carts) {
    if (cart.items.length === 0) continue;
    const vendorIds = new Set(cart.items.map((item) => item.product.vendorId));
    for (const vendorId of vendorIds) {
      const vendorItems = cart.items.filter((item) => item.product.vendorId === vendorId);
      const stillPurchasable = vendorItems.some((item) => item.product.isActive && item.product.stock > 0);
      if (!stillPurchasable) continue; // nothing left to recover — every item is unavailable now.

      const { reminderHours, secondReminderHours } = await configFor(vendorId);
      const oldestItemAge = Math.min(...vendorItems.map((item) => Date.now() - item.createdAt.getTime()));
      const touch = oldestItemAge >= secondReminderHours * 60 * 60 * 1000
        ? { key: "final", title: "Last chance — your cart is waiting", body: "Your items are still waiting. Review availability and current prices before they're gone." }
        : oldestItemAge >= reminderHours * 60 * 60 * 1000
          ? { key: "first", title: "You left something in your cart", body: "Items are waiting in your cart." }
          : null;
      if (!touch) continue;

      await automationService.scheduleAutomation({
        type: "CART_RECOVERY",
        recipientUserId: cart.buyerId,
        vendorId,
        subjectKey: `${cart.id}:${vendorId}:${touch.key}`,
        requiresMarketingConsent: true,
        title: touch.title,
        body: touch.body,
        data: { cart_id: cart.id, vendor_id: vendorId },
      });
      scheduled++;
    }
  }
  return scheduled;
}

/**
 * BUYER_WIN_BACK: for each vendor, a buyer who has bought from THAT vendor
 * before but not again within the vendor's own inactivity window (default
 * 45 days, vendor-configurable). Scoped per-vendor rather than
 * platform-wide, so each vendor's win-back reflects their own buyers.
 */
async function detectBuyerWinBack(): Promise<number> {
  const PAID_STATUSES = ["PAID", "DELIVERED", "COMPLETED"] as const;
  const vendors = await prisma.vendor.findMany({
    where: { isSuspended: false, orderItems: { some: {} } },
    select: { id: true, userId: true },
    take: 500,
  });

  let scheduled = 0;
  for (const vendor of vendors) {
    const { inactivityDays } = (await automationService.getVendorAutomationConfig(vendor.id, "BUYER_WIN_BACK")) as { inactivityDays: number };
    const cutoff = new Date(Date.now() - inactivityDays * DAY_MS);

    const buyers = await prisma.user.findMany({
      where: {
        role: "BUYER",
        isSuspended: false,
        orders: { some: { status: { in: [...PAID_STATUSES] }, vendorId: vendor.id } },
        NOT: {
          orders: { some: { status: { in: [...PAID_STATUSES] }, vendorId: vendor.id, createdAt: { gte: cutoff } } },
        },
      },
      select: { id: true },
      take: 200,
    });

    for (const buyer of buyers) {
      await automationService.scheduleAutomation({
        type: "BUYER_WIN_BACK",
        recipientUserId: buyer.id,
        vendorId: vendor.id,
        subjectKey: `${buyer.id}:${vendor.id}:${isoWeek(new Date())}`,
        frequencyCapDays: 30,
        requiresMarketingConsent: true,
        title: "We miss you at Eki",
        body: "Take a look at what's new.",
      });
      scheduled++;
    }
  }
  return scheduled;
}

/** REVIEW_REQUEST: delivered 1–14 days ago, no review yet. */
async function detectReviewRequest(): Promise<number> {
  const from = new Date(Date.now() - 14 * DAY_MS);
  const to = new Date(Date.now() - DAY_MS);
  const candidates = await prisma.order.findMany({
    where: { status: { in: ["DELIVERED", "COMPLETED"] }, deliveredAt: { gte: from, lte: to } },
    select: { id: true, orderNumber: true, buyerId: true },
    take: 500,
  });
  if (candidates.length === 0) return 0;
  const reviewed = await prisma.review.findMany({
    where: { orderId: { in: candidates.map((o) => o.id) } },
    select: { orderId: true },
  });
  const reviewedOrderIds = new Set(reviewed.map((r) => r.orderId));
  const orders = candidates.filter((o) => !reviewedOrderIds.has(o.id));
  for (const order of orders) {
    await automationService.scheduleAutomation({
      type: "REVIEW_REQUEST",
      recipientUserId: order.buyerId,
      subjectKey: order.id,
      requiresMarketingConsent: true,
      title: "How was your order?",
      body: `Order ${order.orderNumber} was delivered.`,
      data: { order_number: order.orderNumber },
    });
  }
  return orders.length;
}

const LOW_STOCK_REMINDER_COOLDOWN_DAYS = 3;

/**
 * LOW_STOCK_ALERT — bug fix 2026-10-11 ("make low-stock alerts idempotent
 * and state-based"). Previously this was purely time-bucketed
 * (`${vendorId}:${today}`, capped at once/day): it re-alerted every single
 * day the SAME products stayed low, which is exactly the "invasive"
 * behaviour the vendor complained about, and told a vendor nothing had
 * changed when nothing had. Now the dedupe key is the exact SET of
 * currently-low product ids, hashed, plus a coarse multi-day cooldown
 * bucket:
 *   - a genuinely NEW product crossing into low stock changes the hash
 *     immediately -> always alerts right away, regardless of cooldown.
 *   - the identical set of low-stock products re-evaluated tomorrow
 *     produces the identical hash -> naturally deduped by the unique
 *     dedupeKey until the cooldown bucket rolls over (at most once every
 *     LOW_STOCK_REMINDER_COOLDOWN_DAYS while truly unchanged).
 *   - a product restocking (leaving the low set) also changes the hash,
 *     so the vendor sees an accurate "still low: X" list immediately
 *     rather than a stale count.
 * No per-call frequencyCapDays here on purpose — the hash+bucket key IS
 * the cooldown; a separate cap would just fight it.
 */
async function detectLowStockAlert(): Promise<number> {
  const LOW_STOCK_THRESHOLD = 5;
  const products = await prisma.product.findMany({
    where: { isActive: true, stock: { lte: LOW_STOCK_THRESHOLD } },
    select: { id: true, vendorId: true },
    take: 1000,
  });
  const byVendor = new Map<string, string[]>();
  for (const p of products) {
    const list = byVendor.get(p.vendorId) ?? [];
    list.push(p.id);
    byVendor.set(p.vendorId, list);
  }

  const cooldownBucket = Math.floor(Date.now() / (LOW_STOCK_REMINDER_COOLDOWN_DAYS * DAY_MS));

  for (const [vendorId, productIds] of byVendor) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
    if (!vendor) continue;
    const contentHash = crypto.createHash("sha1").update([...productIds].sort().join(",")).digest("hex").slice(0, 10);
    await automationService.scheduleAutomation({
      type: "LOW_STOCK_ALERT",
      recipientUserId: vendor.userId,
      vendorId,
      subjectKey: `${vendorId}:${contentHash}:${cooldownBucket}`,
      requiresMarketingConsent: false,
      title: "Low stock alert",
      body: `${productIds.length} product(s) are running low.`,
      data: { product_count: String(productIds.length) },
    });
  }
  return byVendor.size;
}

/** BUYER_REFERRAL: has purchased before, has never referred anyone. */
async function detectBuyerReferral(): Promise<number> {
  const accountAgeCutoff = new Date(Date.now() - 3 * DAY_MS);
  const candidates = await prisma.user.findMany({
    where: {
      role: "BUYER",
      isSuspended: false,
      referralCode: { not: null },
      createdAt: { lte: accountAgeCutoff },
      orders: { some: { status: { in: ["PAID", "DELIVERED", "COMPLETED"] } } },
    },
    select: { id: true, referralCode: true },
    take: 500,
  });
  if (candidates.length === 0) return 0;
  const referring = await prisma.referral.findMany({
    where: { referrerId: { in: candidates.map((b) => b.id) } },
    select: { referrerId: true },
  });
  const referrerIds = new Set(referring.map((r) => r.referrerId));
  const buyers = candidates.filter((b) => !referrerIds.has(b.id));

  let count = 0;
  for (const buyer of buyers) {
    count++;
    await automationService.scheduleAutomation({
      type: "BUYER_REFERRAL",
      recipientUserId: buyer.id,
      subjectKey: `${buyer.id}:${isoWeek(new Date())}`,
      frequencyCapDays: 30,
      requiresMarketingConsent: true,
      title: "Share Eki, earn rewards",
      body: `Share your code ${buyer.referralCode}.`,
      data: { referral_code: buyer.referralCode },
    });
  }
  return count;
}

/** PAYMENT_RECOVERY: a payment failed in the last 24h and the order is still unpaid. */
async function detectPaymentRecovery(): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const payments = await prisma.payment.findMany({
    where: { status: "FAILED", updatedAt: { gte: since }, order: { status: "PENDING" } },
    select: { id: true, order: { select: { id: true, orderNumber: true, buyerId: true, vendorId: true } } },
    take: 500,
  });
  for (const payment of payments) {
    if (!payment.order) continue;
    await automationService.scheduleAutomation({
      type: "PAYMENT_RECOVERY",
      recipientUserId: payment.order.buyerId,
      // AUTO-06 fix: without vendorId, listVendorActivity(vendorId) could
      // never show this run to any vendor — it was real and sending, just
      // permanently invisible in their Automation Activity.
      vendorId: payment.order.vendorId,
      subjectKey: payment.id,
      requiresMarketingConsent: false,
      title: "Your payment didn't go through",
      body: `Order ${payment.order.orderNumber} needs a new payment attempt.`,
      data: { order_number: payment.order.orderNumber },
    });
  }
  return payments.length;
}

/**
 * REORDER_REMINDER — Final Client Decision 4.
 *
 * Triggers after a completed+delivered order. For each delivered order in
 * the configured window, checks whether:
 *   1. The buyer has marketing consent.
 *   2. The product is still available (active, in stock).
 *   3. The buyer hasn't already reordered that product (completed order
 *      with the same productId after the original order date).
 *   4. The automation is enabled for that vendor.
 *   5. The dedupe key prevents a second reminder for the same order.
 *
 * Uses a fixed 14-day window from delivery as a default timing — mirrors
 * the REVIEW_REQUEST 14-day pattern, the simplest timing that works
 * without requiring a per-vendor "typical order interval" field that
 * doesn't currently exist in the schema.
 */
/**
 * REORDER_REMINDER: one reminder per delivered order+product, inside a
 * vendor-configurable window (default 14 days — see reorderWindowDays in
 * DEFAULT_CONFIG; the data model has no reliable per-product repeat-
 * purchase interval to predict from, so this is a vendor-level default,
 * not a per-product prediction — Eki requirements review, 2026-10-22).
 *
 * Eligibility, rechecked every sweep right before scheduling:
 * 1. Product must still be active and in stock (recheck, not assumed from
 *    order time).
 * 2. The buyer must have no OTHER order for this exact product, placed
 *    after this one, in any active/paid state — not just a completed
 *    repurchase. Previously only PAID/DELIVERED/COMPLETED/AUTO_RELEASED
 *    counted, so a buyer who'd already placed a new order that was still
 *    PROCESSING/DISPATCHED/IN_TRANSIT (or PAYMENT_SECURED/VENDOR_CONFIRMED/
 *    DISPUTED) got a redundant "need more?" nudge for something already on
 *    its way. Reuses FIRST_SALE_PAID_STATUSES — the same "already paid or
 *    further along" status set used elsewhere in this file — rather than
 *    inventing a second list.
 */
async function detectReorderReminder(): Promise<number> {
  const windowCache = new Map<string, number>();
  async function windowDaysFor(vendorId: string): Promise<number> {
    if (!windowCache.has(vendorId)) {
      const config = await automationService.getVendorAutomationConfig(vendorId, "REORDER_REMINDER") as { reorderWindowDays: number };
      windowCache.set(vendorId, config.reorderWindowDays);
    }
    return windowCache.get(vendorId)!;
  }

  // Widest possible window up front (a per-vendor config can only shrink
  // this further below), to keep the DB query itself bounded.
  const widestWindowDays = 90;
  const from = new Date(Date.now() - widestWindowDays * DAY_MS);
  const to = new Date(Date.now() - DAY_MS); // don't remind day-of delivery

  const orders = await prisma.order.findMany({
    where: {
      status: { in: ["DELIVERED", "COMPLETED", "AUTO_RELEASED"] },
      deliveredAt: { gte: from, lte: to },
    },
    select: {
      id: true,
      orderNumber: true,
      buyerId: true,
      vendorId: true,
      deliveredAt: true,
      items: {
        select: {
          productId: true,
          product: { select: { title: true, isActive: true, stock: true } },
        },
      },
    },
    take: 500,
  });

  let scheduled = 0;
  for (const order of orders) {
    if (!order.vendorId) continue; // no single vendor to configure/attribute a window to (e.g. a Community Buy order).
    const windowDays = await windowDaysFor(order.vendorId);
    const deliveredAt = order.deliveredAt ?? new Date(0);
    if (Date.now() - deliveredAt.getTime() > windowDays * DAY_MS) continue; // outside this vendor's configured window

    for (const item of order.items) {
      // 1. Product must still be available.
      if (!item.product.isActive || item.product.stock <= 0) continue;

      // 2. Buyer must not already have a later order for this exact product
      //    in ANY active/paid state (prevents reminders for both a recent
      //    repurchase and an in-flight one).
      const alreadyReordered = await prisma.orderItem.findFirst({
        where: {
          productId: item.productId,
          order: {
            buyerId: order.buyerId,
            status: { in: [...FIRST_SALE_PAID_STATUSES] },
            createdAt: { gt: deliveredAt },
          },
        },
        select: { id: true },
      });
      if (alreadyReordered) continue;

      await automationService.scheduleAutomation({
        type: "REORDER_REMINDER",
        recipientUserId: order.buyerId,
        vendorId: order.vendorId,
        // Dedupe: one reminder per product per order, never resent.
        subjectKey: `${order.id}:${item.productId}`,
        requiresMarketingConsent: true,
        title: "Time to reorder?",
        body: `You ordered ${item.product.title} — need more?`,
        data: {
          order_number: order.orderNumber,
          product_title: item.product.title,
          product_id: item.productId,
        },
      });
      scheduled++;
    }
  }
  return scheduled;
}

/**
 * CHECKOUT_PAYMENT_FOLLOW_UP — Final Client Decision 4.
 *
 * Triggers when a marketplace Checkout is abandoned or its PaymentIntent
 * failed (separate from PAYMENT_RECOVERY, which is exclusively for Regular
 * Delivery subscription renewal payment failures).
 *
 * Uses the Checkout model (status: PENDING = not yet paid, SUCCEEDED =
 * payment captured, FAILED = PI confirmed failed). PaymentStatus enum in
 * Prisma is: PENDING | SUCCEEDED | FAILED — there is no PROCESSING value.
 *
 * CRITICAL: A real freshness recheck re-reads the checkout status from the
 * DB immediately before sending. If it is now SUCCEEDED, no message is sent.
 * This prevents messaging buyers whose payment succeeded after the initial
 * batch query ran (race-condition guard).
 *
 * Window: Checkouts that have been PENDING for more than 2 hours but less
 * than 48 hours. Stale enough to be abandoned, recent enough to be
 * actionable.
 */
async function detectCheckoutPaymentFollowUp(): Promise<number> {
  const MIN_AGE_MS = 2 * 60 * 60 * 1000;  // 2 hours — not a timing glitch
  const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours — still actionable
  const now = new Date();
  const minAge = new Date(now.getTime() - MAX_AGE_MS);
  const maxAge = new Date(now.getTime() - MIN_AGE_MS);

  // Query PENDING Checkouts (the checkout-level entity, not individual orders).
  // A checkout can span multiple orders, but we dedupe per checkout so the
  // buyer gets exactly one follow-up regardless of how many orders are in it.
  const pendingCheckouts = await prisma.checkout.findMany({
    where: {
      status: "PENDING",
      createdAt: { gte: minAge, lte: maxAge },
    },
    select: {
      id: true,
      buyerId: true,
      orders: {
        select: { id: true, orderNumber: true, vendorId: true },
        take: 1,
      },
    },
    take: 500,
  });

  let scheduled = 0;
  for (const checkout of pendingCheckouts) {
    const order = checkout.orders[0];
    if (!order) continue;

    // CRITICAL RECHECK — re-read the checkout status immediately before
    // deciding to send (guards against payment succeeding between the
    // batch query above and this point). This is the exact guard the client
    // specified: "immediately before sending, re-check real payment status."
    const fresh = await prisma.checkout.findUnique({
      where: { id: checkout.id },
      select: { status: true },
    });
    if (!fresh) continue;
    // Only send for still-pending checkouts. SUCCEEDED = paid, don't message.
    if (fresh.status !== "PENDING") continue;

    await automationService.scheduleAutomation({
      type: "CHECKOUT_PAYMENT_FOLLOW_UP",
      recipientUserId: checkout.buyerId,
      vendorId: order.vendorId ?? undefined,
      // Deterministic dedupe: one follow-up per checkout, never resent.
      subjectKey: `checkout_followup:${checkout.id}`,
      requiresMarketingConsent: true,
      title: "Complete your purchase",
      body: `Your order ${order.orderNumber} is waiting — complete payment to confirm your items.`,
      data: { order_number: order.orderNumber, order_id: order.id, checkout_id: checkout.id },
    });
    scheduled++;
  }
  return scheduled;
}


export const automationDetectors = {
  /**
   * Runs every detector that has no dependency on Regular Deliveries or
   * Community Buy data (those are wired in separately once those modules
   * exist). Intended to be called from a cron-triggered internal route,
   * not from request-handling code.
   */
  async runSweep(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    results.VENDOR_TRIAL_ENDING_DUE = await automationService.dispatchDueVendorTrialEnding();
    // Order IS the coalescing priority (bug fix 2026-10-11): transactional
    // types (PAYMENT_RECOVERY, CHECKOUT_PAYMENT_FOLLOW_UP) bypass coalescing
    // entirely and their position doesn't matter; among the rest, whichever
    // detector runs first claims a given recipient for this sweep, so the
    // most time/business-critical non-urgent nudge goes first: a vendor's
    // own low-stock situation outranks "finish verifying your email", which
    // outranks the FIRST_SALE onboarding nudge (verify before you're told to
    // list products), which outranks a buyer-facing cart/review/win-back/
    // referral prompt.
    const jobs: [string, () => Promise<number>][] = [
      ["LOW_STOCK_ALERT", detectLowStockAlert],
      ["REGISTRATION_REMINDER", detectRegistrationReminder],
      ["FIRST_PRODUCT_REMINDER", detectFirstProductReminder],
      ["DRAFT_PRODUCT_REMINDER", detectDraftProductReminder],
      ["DELIVERY_SETUP_REMINDER", detectDeliverySetupReminder],
      ["VERIFICATION_REMINDER", detectVerificationReminder],
      ["FIRST_SALE", detectFirstSale],
      ["STORE_SHARE_REMINDER", detectStoreShareReminder],
      ["AUTOMATION_FAILURE_ALERT", detectAutomationFailureAlert],
      ["CART_RECOVERY", detectCartRecovery],
      ["REORDER_REMINDER", detectReorderReminder],
      ["REVIEW_REQUEST", detectReviewRequest],
      ["BUYER_WIN_BACK", detectBuyerWinBack],
      ["BUYER_REFERRAL", detectBuyerReferral],
      ["PAYMENT_RECOVERY", detectPaymentRecovery],
      ["CHECKOUT_PAYMENT_FOLLOW_UP", detectCheckoutPaymentFollowUp],
      ["VENDOR_TRIAL_ENDING", detectVendorTrialEnding],
    ];
    await runWithCoalesceScope(async () => {
      for (const [name, job] of jobs) {
        // Admin-paused / archived / draft rule: skip the whole detector and record why.
        const gate = await getRuleGate(name);
        if (!gate.runnable) {
          results[name] = 0;
          await noteRuleSkipped(name, gate.reason ?? "rule_paused");
          eventsService.emit({
            name: EVENT_NAMES.automation_suppressed,
            actorType: "system",
            entityType: "AutomationRule",
            entityId: name,
            source: "automation_sweep",
            payload: { ruleKey: name, reason: gate.reason ?? "rule_paused", state: gate.state },
          });
          logger.info("Automation detector skipped: rule not active", { detector: name, reason: gate.reason });
          continue;
        }
        try {
          results[name] = await job();
        } catch (error) {
          logger.error("Automation detector failed", { detector: name, error: error instanceof Error ? error.message : String(error) });
          results[name] = -1;
        }
      }
    });
    return results;
  },
};

