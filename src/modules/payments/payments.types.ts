export type CreatePaymentIntentItemInput = {
  productId: string;
  quantity: number;
};

export type CreatePaymentIntentInput = {
  buyerId: string;
  items: CreatePaymentIntentItemInput[];
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
};

export type CreatePaymentIntentResponse = {
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
  clientSecret: string;
};
