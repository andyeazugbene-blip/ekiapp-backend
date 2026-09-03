/**
 * Internal payment-provider abstraction (architecture doc §2).
 *
 * This interface exists so business modules CAN depend on a
 * provider-neutral contract instead of importing the Stripe SDK or the
 * Paystack client directly. It does not yet replace the direct Stripe/
 * Paystack calls inside payments.service.ts, stripe.service.ts, or
 * paystack.service.ts — those are deeply tested, multi-vendor,
 * metadata-driven flows (checkout splitting, wallet top-ups, gift cards,
 * subscriptions) and migrating them onto a generic interface is a separate,
 * larger, higher-risk project than this pass. See
 * docs/decisions/0007-payment-provider-abstraction.md for the adoption plan.
 *
 * New call sites — and any future refactor of the existing ones — should
 * go through this interface rather than calling Stripe/Paystack directly.
 */

export type MinorAmount = number; // smallest currency unit (cents, kobo, pesewas)

export interface ProviderCustomer {
  providerCustomerId: string;
}

export interface ProviderPaymentMethod {
  providerPaymentMethodId: string;
}

export interface ProviderPaymentResult {
  providerRef: string; // PaymentIntent id / Paystack reference
  status: "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "PENDING";
  clientSecret?: string; // Stripe only — null for redirect-based providers
  redirectUrl?: string; // Paystack authorization_url — null for Stripe
}

export interface ProviderVerifyResult {
  providerRef: string;
  status: "SUCCEEDED" | "FAILED" | "PENDING";
  amount: MinorAmount;
  currency: string;
}

export interface ProviderRefundResult {
  providerRefundRef: string;
  status: "SUCCEEDED" | "PENDING" | "FAILED";
}

export interface ProviderTransferResult {
  providerTransferRef: string;
  status: "SUCCEEDED" | "PENDING" | "FAILED";
}

export interface ProviderWebhookEvent {
  providerEventId: string;
  type: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: "stripe" | "paystack";

  createCustomer(input: { email: string; name?: string }): Promise<ProviderCustomer>;
  attachPaymentMethod(input: { providerCustomerId: string; providerPaymentMethodId: string }): Promise<ProviderPaymentMethod>;

  createPayment(input: { amount: MinorAmount; currency: string; providerCustomerId?: string; metadata?: Record<string, string>; idempotencyKey: string }): Promise<ProviderPaymentResult>;
  verifyPayment(providerRef: string): Promise<ProviderVerifyResult>;

  createAuthorisation(input: { amount: MinorAmount; currency: string; providerCustomerId?: string; metadata?: Record<string, string>; idempotencyKey: string }): Promise<ProviderPaymentResult>;
  captureAuthorisation(providerRef: string, amount?: MinorAmount): Promise<ProviderVerifyResult>;
  cancelAuthorisation(providerRef: string): Promise<void>;

  chargeSavedPaymentMethod(input: { providerCustomerId: string; providerPaymentMethodId: string; amount: MinorAmount; currency: string; metadata?: Record<string, string>; idempotencyKey: string }): Promise<ProviderPaymentResult>;

  createRefund(input: { providerRef: string; amount?: MinorAmount; idempotencyKey: string }): Promise<ProviderRefundResult>;
  verifyRefund(providerRefundRef: string): Promise<ProviderRefundResult>;

  createTransfer(input: { destinationAccountRef: string; amount: MinorAmount; currency: string; idempotencyKey: string }): Promise<ProviderTransferResult>;
  verifyTransfer(providerTransferRef: string): Promise<ProviderTransferResult>;

  retrieveTransaction(providerRef: string): Promise<ProviderVerifyResult>;

  processWebhook(rawBody: string | Buffer, signature: string): ProviderWebhookEvent;

  /**
   * Compares local records against the provider's own transaction list for
   * a period. Returns differences only — never mutates anything, on either
   * side. `localRecords` carries the amount actually recorded locally so a
   * real amount comparison is possible, not just a presence check.
   */
  reconcileTransactions(input: { periodStart: Date; periodEnd: Date; localRecords: { ref: string; amount: MinorAmount }[] }): Promise<ReconciliationResult>;
}

export interface ReconciliationResult {
  /** A local ref (e.g. Stripe PaymentIntent id) that never turned up at the provider for this period. */
  missingAtProvider: string[];
  /** A provider-side succeeded transaction with no matching local ref. */
  missingLocally: { ref: string; amount: MinorAmount }[];
  /** Same ref on both sides, but the amounts disagree. */
  amountMismatches: { ref: string; localAmount: MinorAmount; providerAmount: MinorAmount }[];
}
