export type StripeWebhookInput = {
  signature: string;
  rawBody: Buffer;
};

export type PaymentIntentSucceededMetadata = {
  orderId: string;
  paymentId: string;
  buyerId: string;
  vendorId: string;
};

export type StripeWebhookResult = {
  received: true;
  eventId: string;
  type: string;
  duplicate?: boolean;
  ignored?: boolean;
};
