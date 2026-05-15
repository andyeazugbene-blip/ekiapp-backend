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
};

export type NormalizedPaymentItem = CreatePaymentIntentItemInput;

export type PricedOrderItem = {
  productId: string;
  vendorId: string;
  quantity: number;
  unitAmount: number;
  totalAmount: number;
  currency: string;
  productTitle: string;
  weightGrams: number;
};

export type CreatePaymentIntentResponse = {
  checkoutId: string;
  orderIds: string[];
  amount: number;
  currency: string;
  clientSecret: string;
};
