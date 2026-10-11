import { prisma } from "../../lib/prisma";
import { notTest } from "../../shared/utils/test-records";

/**
 * Vendor onboarding funnel (2026-10-11 request: "an analytical setup
 * connected to the app backend and the onboarding... If vendors drop off
 * at one of those steps once marketing starts, you'll pay to acquire them
 * and lose them without knowing where.").
 *
 * Extended 2026-10-11 (part B of the follow-up request) to the full
 * requested stage list: Registration -> Store setup -> Product added ->
 * Delivery configured -> Verification -> Store published -> Store shared
 * -> First order. Two of those stages do NOT have a real, honest signal
 * in the current schema -- rather than inventing one, they are reported
 * as `available: false` with the exact reason, in `unavailableStages`:
 *
 *  - "Store setup": Vendor.storeName/storeSlug/description are all set
 *    atomically inside register() in the SAME transaction that creates the
 *    Vendor row -- there is no separate "finished setting up the store"
 *    moment in the data model; it IS registration. Tracking it as a
 *    distinct stage would just duplicate the "Registered" number under a
 *    different label.
 *  - "Store published": no `publishedAt`/`isLive` column exists on Vendor.
 *    The closest real proxy -- having both a product and a delivery zone
 *    -- is already visible as the combination of the "Added a foodstuff"
 *    and "Set up delivery" stages; inventing a third derived timestamp on
 *    top of those two would not be new information.
 *
 * The remaining stages ARE driven by real, authoritative data:
 *  - Registered / Added a foodstuff / Set up delivery / Verified: the SAME
 *    columns the vendor app's own activation checklist
 *    (app/(vendor)/activation.tsx) reads, so this can never drift from
 *    what the vendor sees as checked off, and has real history from the
 *    day each column started being populated, not just from today.
 *  - "Store shared": the app has no persisted "vendor tapped share"
 *    event (Share.share() is a local OS action never reported to the
 *    backend) -- the honest, weaker, later-firing proxy used instead is
 *    the first `store_viewed` event for that vendor (someone actually
 *    opened the store), clearly labeled as a proxy, not claimed as
 *    "shared."
 *  - "First order": Order.vendorId + Payment.status/processedAt, both
 *    real columns.
 *
 * Acquisition/campaign attribution: NOT available. There is no UTM,
 * referral-source, or campaign-id column anywhere on Vendor, User, or
 * registration input in the current schema — see `attribution` in the
 * result, which says so explicitly rather than fabricating a source.
 */

const VALID_RANGES = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 } as const;
export type FunnelRange = keyof typeof VALID_RANGES;

function startOfDayUtc(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function sinceDateForRange(days: number): Date {
  const d = startOfDayUtc(new Date());
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
}

export function parseFunnelRange(raw: unknown): FunnelRange {
  if (typeof raw === "string" && raw in VALID_RANGES) return raw as FunnelRange;
  return "30d";
}

/** Explicit from/to override (bug fix 2026-10-11 part B: "date-range filtering"). Both must parse as valid dates and from <= to, or this returns null and the caller falls back to the preset range. */
export function parseExplicitDateRange(rawFrom: unknown, rawTo: unknown): { from: Date; to: Date } | null {
  if (typeof rawFrom !== "string" || typeof rawTo !== "string") return null;
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from.getTime() > to.getTime()) return null;
  return { from: startOfDayUtc(from), to };
}

type StageId = "registered" | "product_added" | "delivery_configured" | "verified" | "store_visited" | "first_order";

export interface FunnelVendorRef {
  vendorId: string;
  storeName: string;
  email: string | null;
  registeredAt: string;
  daysSinceRegistration: number;
}

export interface FunnelStep {
  available: true;
  id: StageId;
  label: string;
  vendorCount: number;
  /** % of the step before this one (100 for the first step). */
  conversionFromPrevious: number;
  /** % of the original registered cohort. */
  conversionFromStart: number;
  droppedHere: number;
  /** Median days from registration to reaching this step, among vendors who reached it. Null if nobody has yet. */
  medianDaysFromRegistration: number | null;
  /** Vendors who reached the PRECEDING step but not this one — capped at 50, oldest-registered first. */
  stuckVendors: FunnelVendorRef[];
}

export interface UnavailableFunnelStage {
  available: false;
  id: "store_setup" | "store_published";
  label: string;
  reason: string;
}

export interface VendorFunnelResult {
  range: FunnelRange;
  since: string;
  until: string;
  cohortSize: number;
  steps: FunnelStep[];
  /** Stages the requested funnel named that the current schema cannot support accurately — see each one's `reason`. Not interleaved into `steps` so a consumer can't accidentally plot them as if they had real counts. */
  unavailableStages: UnavailableFunnelStage[];
  attribution: { available: false; reason: string };
}

function median(valuesMs: number[]): number | null {
  if (valuesMs.length === 0) return null;
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round((ms / 86_400_000) * 10) / 10;
}

export const adminVendorFunnelService = {
  async getFunnel(rawRange: unknown, rawFrom?: unknown, rawTo?: unknown): Promise<VendorFunnelResult> {
    const explicit = parseExplicitDateRange(rawFrom, rawTo);
    const range = parseFunnelRange(rawRange);
    const since = explicit?.from ?? sinceDateForRange(VALID_RANGES[range]);
    const until = explicit?.to ?? new Date();

    const cohort = await prisma.vendor.findMany({
      where: { createdAt: { gte: since, lte: until }, ...notTest() },
      select: { id: true, storeName: true, createdAt: true, verifiedAt: true, user: { select: { email: true } } },
      orderBy: { createdAt: "asc" },
    });
    const cohortIds = cohort.map((v) => v.id);
    const byId = new Map(cohort.map((v) => [v.id, v]));

    const unavailableStages: UnavailableFunnelStage[] = [
      { available: false, id: "store_setup", label: "Store setup", reason: "Store profile fields (name, slug, description) are set atomically at registration in the same transaction that creates the Vendor row — there is no separate completion moment to measure; this stage is the same event as Registered." },
      { available: false, id: "store_published", label: "Store published", reason: "No publishedAt/isLive column exists on Vendor. The real proxy for 'can actually be ordered from' is already shown as the combination of Added a foodstuff + Set up delivery below." },
    ];
    const attribution: VendorFunnelResult["attribution"] = {
      available: false,
      reason: "No UTM, referral-source, or campaign-id field exists on Vendor, User, or the registration input in the current schema. Adding campaign attribution requires capturing a source at signup time first — see docs/OWNER_PRODUCT_DECISIONS.md for the related referral/attribution decisions already pending.",
    };

    if (cohortIds.length === 0) {
      return { range, since: since.toISOString(), until: until.toISOString(), cohortSize: 0, steps: [], unavailableStages, attribution };
    }

    // One grouped query per real stage rather than N+1 — intentionally
    // measures "ever reached" (the product/zone/order may have been
    // created after the cohort's registration window), same convention as
    // other admin funnel/cohort reports in this codebase.
    const [firstProducts, firstZones, firstStoreViews, firstOrders] = await Promise.all([
      prisma.product.groupBy({ by: ["vendorId"], where: { vendorId: { in: cohortIds }, ...notTest() }, _min: { createdAt: true } }),
      prisma.deliveryZone.groupBy({ by: ["vendorId"], where: { vendorId: { in: cohortIds } }, _min: { createdAt: true } }),
      prisma.event.groupBy({
        by: ["entityId"],
        where: { name: "store_viewed", entityType: "Vendor", entityId: { in: cohortIds } },
        _min: { occurredAt: true },
      }),
      // "First order" = first order with a SUCCEEDED payment. Payment.processedAt
      // is the real paid-at timestamp; Order.createdAt is the documented
      // fallback for the rare legacy row where a succeeded payment predates
      // that column being populated.
      prisma.order.findMany({
        where: { vendorId: { in: cohortIds }, payment: { status: "SUCCEEDED" }, ...notTest() },
        select: { vendorId: true, createdAt: true, payment: { select: { processedAt: true } } },
      }),
    ]);
    const firstProductAt = new Map(firstProducts.map((r) => [r.vendorId, r._min.createdAt]));
    const firstZoneAt = new Map(firstZones.map((r) => [r.vendorId, r._min.createdAt]));
    const firstViewAt = new Map(firstStoreViews.map((r) => [r.entityId, r._min.occurredAt]));
    const firstOrderAt = new Map<string, Date>();
    for (const o of firstOrders) {
      if (!o.vendorId) continue;
      const at = o.payment?.processedAt ?? o.createdAt;
      const existing = firstOrderAt.get(o.vendorId);
      if (!existing || at < existing) firstOrderAt.set(o.vendorId, at);
    }

    function buildStage(
      id: StageId,
      label: string,
      reachedAt: (vendorId: string) => Date | null | undefined,
    ): { label: string; id: StageId; vendorCount: number; medianDaysFromRegistration: number | null; reachedIds: Set<string> } {
      const reachedIds = new Set<string>();
      const days: number[] = [];
      for (const v of cohort) {
        const at = reachedAt(v.id);
        if (at) {
          reachedIds.add(v.id);
          days.push(at.getTime() - v.createdAt.getTime());
        }
      }
      return { id, label, vendorCount: reachedIds.size, medianDaysFromRegistration: median(days), reachedIds };
    }

    const stages = [
      buildStage("registered", "Registered", (id) => byId.get(id)?.createdAt ?? null),
      buildStage("product_added", "Added a foodstuff", (id) => firstProductAt.get(id) ?? null),
      buildStage("delivery_configured", "Set up delivery", (id) => firstZoneAt.get(id) ?? null),
      buildStage("verified", "Verified their account", (id) => byId.get(id)?.verifiedAt ?? null),
      buildStage("store_visited", "Store ever visited (proxy for “shared”)", (id) => firstViewAt.get(id) ?? null),
      buildStage("first_order", "First order", (id) => firstOrderAt.get(id) ?? null),
    ];

    function vendorRefs(ids: Set<string>): FunnelVendorRef[] {
      return cohort
        .filter((v) => ids.has(v.id))
        .map((v) => ({
          vendorId: v.id,
          storeName: v.storeName,
          email: v.user?.email ?? null,
          registeredAt: v.createdAt.toISOString(),
          daysSinceRegistration: Math.floor((Date.now() - v.createdAt.getTime()) / 86_400_000),
        }))
        .sort((a, b) => b.daysSinceRegistration - a.daysSinceRegistration)
        .slice(0, 50);
    }

    const steps: FunnelStep[] = stages.map((s, i) => {
      const previousCount = i === 0 ? s.vendorCount : stages[i - 1].vendorCount;
      const startCount = stages[0].vendorCount || 1;
      const stuckIds = i === 0 ? new Set<string>() : [...stages[i - 1].reachedIds].filter((id) => !s.reachedIds.has(id));
      return {
        available: true,
        id: s.id,
        label: s.label,
        vendorCount: s.vendorCount,
        medianDaysFromRegistration: s.medianDaysFromRegistration,
        conversionFromPrevious: previousCount === 0 ? 0 : Math.round((s.vendorCount / previousCount) * 1000) / 10,
        conversionFromStart: Math.round((s.vendorCount / startCount) * 1000) / 10,
        droppedHere: i === 0 ? 0 : stages[i - 1].reachedIds.size - s.reachedIds.size,
        stuckVendors: vendorRefs(new Set(stuckIds)),
      };
    });

    return { range, since: since.toISOString(), until: until.toISOString(), cohortSize: cohort.length, steps, unavailableStages, attribution };
  },
};
