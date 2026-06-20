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
};
