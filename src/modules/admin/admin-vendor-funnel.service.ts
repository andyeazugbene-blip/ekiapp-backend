import { prisma } from "../../lib/prisma";
import { notTest } from "../../shared/utils/test-records";

/**
 * Vendor onboarding funnel (2026-10-11 request: "an analytical setup
 * connected to the app backend and the onboarding... If vendors drop off
 * at one of those steps once marketing starts, you'll pay to acquire them
 * and lose them without knowing where.").
 *
 * Deliberately driven by the same AUTHORITATIVE columns the vendor app's
 * own activation checklist (app/(vendor)/activation.tsx) reads to decide
 * each step is "done" -- Product existence, DeliveryZone existence,
 * Vendor.verifiedAt -- not a parallel bookkeeping system that could drift
 * from what the vendor actually sees as checked off. This also means
 * every vendor who ever registered has real historical data from day
 * one, not just vendors who sign up after this file exists.
 *
 * The one step with no authoritative column ("share your store link" is a
 * client-only, unpersisted action in the current app build) is reported
 * from the `store_viewed` canonical event instead, and labeled honestly
 * as "store ever visited" rather than claimed to be "vendor tapped
 * share" -- that distinction matters: it is a weaker, later-firing
 * signal (someone has to actually open the link), not a direct proxy.
 */

const VALID_RANGES = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 } as const;
export type FunnelRange = keyof typeof VALID_RANGES;

function sinceDate(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
}

export function parseFunnelRange(raw: unknown): FunnelRange {
  if (typeof raw === "string" && raw in VALID_RANGES) return raw as FunnelRange;
  return "30d";
}

export interface FunnelStep {
  id: "registered" | "product_added" | "delivery_configured" | "verified" | "store_visited";
  label: string;
  vendorCount: number;
  /** % of the step before this one (100 for the first step). */
  conversionFromPrevious: number;
  /** % of the original registered cohort. */
  conversionFromStart: number;
  droppedHere: number;
  /** Median days from registration to reaching this step, among vendors who reached it. Null if nobody has yet. */
  medianDaysFromRegistration: number | null;
}

export interface VendorFunnelResult {
  range: FunnelRange;
  since: string;
  cohortSize: number;
  steps: FunnelStep[];
  /** Vendors in the cohort who registered but have not reached ANY further step, oldest first -- the people marketing spend is being lost on right now. */
  stuckAtRegistration: Array<{ vendorId: string; storeName: string; email: string | null; registeredAt: string; daysSinceRegistration: number }>;
}

function median(valuesMs: number[]): number | null {
  if (valuesMs.length === 0) return null;
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round((ms / 86_400_000) * 10) / 10;
}

export const adminVendorFunnelService = {
  async getFunnel(rawRange: unknown): Promise<VendorFunnelResult> {
    const range = parseFunnelRange(rawRange);
    const since = sinceDate(VALID_RANGES[range]);

    const cohort = await prisma.vendor.findMany({
      where: { createdAt: { gte: since }, ...notTest() },
      select: { id: true, storeName: true, createdAt: true, verifiedAt: true, user: { select: { email: true } } },
      orderBy: { createdAt: "asc" },
    });
    const cohortIds = cohort.map((v) => v.id);
    const byId = new Map(cohort.map((v) => [v.id, v]));

    if (cohortIds.length === 0) {
      return { range, since: since.toISOString(), cohortSize: 0, steps: [], stuckAtRegistration: [] };
    }

    // First-product and first-delivery-zone timestamps per vendor, one
    // grouped query each rather than N+1 — this intentionally measures
    // "ever reached" (the product/zone may have been created after the
    // range window), same convention as other admin funnel/cohort reports.
    const [firstProducts, firstZones, firstStoreViews] = await Promise.all([
      prisma.product.groupBy({ by: ["vendorId"], where: { vendorId: { in: cohortIds }, ...notTest() }, _min: { createdAt: true } }),
      prisma.deliveryZone.groupBy({ by: ["vendorId"], where: { vendorId: { in: cohortIds } }, _min: { createdAt: true } }),
      prisma.event.groupBy({
        by: ["entityId"],
        where: { name: "store_viewed", entityType: "Vendor", entityId: { in: cohortIds } },
        _min: { occurredAt: true },
      }),
    ]);
    const firstProductAt = new Map(firstProducts.map((r) => [r.vendorId, r._min.createdAt]));
    const firstZoneAt = new Map(firstZones.map((r) => [r.vendorId, r._min.createdAt]));
    const firstViewAt = new Map(firstStoreViews.map((r) => [r.entityId, r._min.occurredAt]));

    function buildStep(
      id: FunnelStep["id"],
      label: string,
      reachedAt: (vendorId: string) => Date | null | undefined,
    ): { step: Omit<FunnelStep, "conversionFromPrevious" | "conversionFromStart" | "droppedHere">; reachedIds: Set<string> } {
      const reachedIds = new Set<string>();
      const days: number[] = [];
      for (const v of cohort) {
        const at = reachedAt(v.id);
        if (at) {
          reachedIds.add(v.id);
          days.push(at.getTime() - v.createdAt.getTime());
        }
      }
      return {
        step: { id, label, vendorCount: reachedIds.size, medianDaysFromRegistration: median(days) },
        reachedIds,
      };
    }

    const raw = [
      buildStep("registered", "Registered", (id) => byId.get(id)?.createdAt ?? null),
      buildStep("product_added", "Added a foodstuff", (id) => firstProductAt.get(id) ?? null),
      buildStep("delivery_configured", "Set up delivery", (id) => firstZoneAt.get(id) ?? null),
      buildStep("verified", "Verified their account", (id) => byId.get(id)?.verifiedAt ?? null),
      buildStep("store_visited", "Store ever visited (proxy for “shared”)", (id) => firstViewAt.get(id) ?? null),
    ];

    const steps: FunnelStep[] = raw.map((r, i) => {
      const previousCount = i === 0 ? r.step.vendorCount : raw[i - 1].step.vendorCount;
      const startCount = raw[0].step.vendorCount || 1;
      return {
        ...r.step,
        conversionFromPrevious: previousCount === 0 ? 0 : Math.round((r.step.vendorCount / previousCount) * 1000) / 10,
        conversionFromStart: Math.round((r.step.vendorCount / startCount) * 1000) / 10,
        droppedHere: i === 0 ? 0 : raw[i - 1].reachedIds.size - r.reachedIds.size,
      };
    });

    const reachedProductIds = raw[1].reachedIds;
    const stuckAtRegistration = cohort
      .filter((v) => !reachedProductIds.has(v.id))
      .map((v) => ({
        vendorId: v.id,
        storeName: v.storeName,
        email: v.user?.email ?? null,
        registeredAt: v.createdAt.toISOString(),
        daysSinceRegistration: Math.floor((Date.now() - v.createdAt.getTime()) / 86_400_000),
      }))
      .sort((a, b) => b.daysSinceRegistration - a.daysSinceRegistration);

    return { range, since: since.toISOString(), cohortSize: cohort.length, steps, stuckAtRegistration };
  },
};
