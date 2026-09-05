export interface CalculateDeliveryInput {
  cartId: string;
  destinationZoneId: string;
  /** The buyer's checkout currency. Defaults to the cart's own dominant
   * currency (its first item's) when omitted, preserving old behavior for
   * a single-currency cart with no explicit choice. */
  checkoutCurrency?: string;
}

export interface CalculateDeliveryResult {
  subtotalAmount: number;
  deliveryAmount: number;
  totalAmount: number;
  totalWeightGrams: number;
  currency: string;
}
