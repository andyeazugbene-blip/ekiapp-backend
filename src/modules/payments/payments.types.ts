export type CreatePaymentIntentItemInput = {
  productId: string;
  quantity: number;
};

export type CreatePaymentIntentInput = {
  buyerId: string;
  items: CreatePaymentIntentItemInput[];
};

export type CreatePaymentIntentFromCartInput = {
  cartId: string;
  destinationZoneId?: string;
  deliveryAddress?: string;
  deliveryCountry?: string;
  walletAmount?: number;
  promoCode?: string;
  promoVendorId?: string;
  /** Buyer's chosen checkout currency. A cart may hold products in
   * different native currencies — every line item, delivery fee, and
   * discount is normalized into this ONE currency before Stripe ever sees
   * an amount. Defaults to the cart's first item's native currency when
   * omitted (see payments.service.ts). */
  checkoutCurrency?: string;
};

export type NormalizedPaymentItem = CreatePaymentIntentItemInput;

export type PricedOrderItem = {
  productId: string;
  vendorId: string;
  quantity: number;
  unitAmount: number;
  totalAmount: number;
  costAmount?: number | null;
  costCurrency?: string | null;
  currency: string;
  productTitle: string;
  weightGrams: number;
};

export type CreatePaymentIntentResponse = {
  /** Stripe PaymentIntent id (`pi_...`). Empty string when fully wallet-paid. */
  paymentIntentId: string;
  /** Stripe PaymentIntent client_secret. The literal string "wallet_paid" when no Stripe call was made. */
  clientSecret: string;
  checkoutId: string;
  orderIds: string[];
  amount: number;
  currency: string;
  discountAmount?: number;
  promoCode?: string;
  campaignId?: string;
  campaignTitle?: string;
  campaignDiscount?: number;
  /** Present only when at least one vendor's native currency differed from
   * the checkout currency — lets the buyer see that a conversion happened. */
  conversionApplied?: boolean;
};
