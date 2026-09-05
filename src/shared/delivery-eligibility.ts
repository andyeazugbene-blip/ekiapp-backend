import type { DeliveryZone } from "@prisma/client";

import { prisma } from "../lib/prisma";

export type VendorEligibilityReason = "VENDOR_ZONE_INACTIVE" | "NO_COVERAGE";

export interface VendorEligibilityResult {
  vendorId: string;
  eligible: boolean;
  /** The zone whose fee should be used for this vendor. Null when ineligible. */
  zone: DeliveryZone | null;
  reason?: VendorEligibilityReason;
}

/**
 * The shared, admin-managed zone for a country (vendorId: null) — Eki's
 * default delivery coverage that every vendor inherits unless they've
 * configured their own zone for that country. Must filter vendorId: null
 * explicitly; a plain `findFirst({ country })` could otherwise return an
 * arbitrary vendor's own zone as the "global" fallback for every OTHER
 * vendor in the cart.
 */
export async function findGlobalDeliveryZone(country: string): Promise<DeliveryZone | null> {
  return prisma.deliveryZone.findFirst({
    where: { vendorId: null, country: { equals: country, mode: "insensitive" }, isActive: true },
  });
}

/**
 * Resolves one vendor's delivery eligibility/zone for a country,
 * independently of every other vendor in the cart.
 *
 * - No zone of their own for this country → inherits the global zone
 *   (Eki's default coverage). Eligible if a global zone exists.
 * - A zone of their own for this country, active → use it (their own rate
 *   overrides the global one). Always eligible.
 * - A zone of their own for this country, explicitly deactivated (the
 *   "Active" toggle on the vendor's delivery-zone screen) → the vendor has
 *   explicitly opted out of delivering to this country. Ineligible — this
 *   does NOT fall back to the global zone, otherwise a vendor would have no
 *   way to actually stop shipping somewhere.
 */
export async function resolveVendorDeliveryZone(
  vendorId: string,
  country: string,
  globalZone: DeliveryZone | null,
): Promise<VendorEligibilityResult> {
  const vendorZone = await prisma.deliveryZone.findFirst({
    where: { vendorId, country: { equals: country, mode: "insensitive" } },
  });

  if (vendorZone) {
    if (!vendorZone.isActive) {
      return { vendorId, eligible: false, zone: null, reason: "VENDOR_ZONE_INACTIVE" };
    }
    return { vendorId, eligible: true, zone: vendorZone };
  }

  if (globalZone) {
    return { vendorId, eligible: true, zone: globalZone };
  }

  return { vendorId, eligible: false, zone: null, reason: "NO_COVERAGE" };
}
