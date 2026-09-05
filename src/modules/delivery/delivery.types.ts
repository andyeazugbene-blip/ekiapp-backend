import type { VendorEligibilityReason } from "../../shared/delivery-eligibility";

export interface CalculateDeliveryInput {
  cartId: string;
  /** Either a specific zone id (legacy) or a plain country name — the
   * backend resolves each vendor's own eligibility/zone for that country
   * independently, so a country name is enough and is now preferred. */
  destinationZoneId?: string;
  deliveryCountry?: string;
  /** The buyer's checkout currency. Defaults to the cart's own dominant
   * currency (its first item's) when omitted, preserving old behavior for
   * a single-currency cart with no explicit choice. */
  checkoutCurrency?: string;
}

export interface VendorDeliveryEligibility {
  vendorId: string;
  vendorName: string;
  eligible: boolean;
  reason?: VendorEligibilityReason;
  productIds: string[];
  productTitles: string[];
  /** Present only when eligible — this vendor's contribution to the totals
   * below, already normalized into the checkout currency. */
  subtotalAmount?: number;
  deliveryAmount?: number;
}

export interface CalculateDeliveryResult {
  /** True only when every vendor in the cart can deliver to this address. */
  eligible: boolean;
  /** Sums include ELIGIBLE vendor groups only — an ineligible vendor never
   * silently inflates or corrupts the estimate shown for the rest of the
   * cart. */
  subtotalAmount: number;
  deliveryAmount: number;
  totalAmount: number;
  totalWeightGrams: number;
  currency: string;
  vendors: VendorDeliveryEligibility[];
}
