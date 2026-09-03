import { env } from "../../../config/env";
import { stripe } from "../../../lib/stripe";
import { AppError } from "../../../shared/errors/app-error";
import type {
  MinorAmount,
  PaymentProvider,
  ProviderPaymentMethod,
  ProviderPaymentResult,
  ProviderRefundResult,
  ProviderTransferResult,
  ProviderVerifyResult,
  ProviderWebhookEvent,
} from "./payment-provider.interface";

function mapIntentStatus(status: string): ProviderPaymentResult["status"] {
  if (status === "succeeded") return "SUCCEEDED";
  if (status === "requires_payment_method" || status === "canceled") return "FAILED";
  if (status === "requires_action" || status === "requires_confirmation") return "REQUIRES_ACTION";
  return "PENDING";
}

/** Thin wrapper over the existing `stripe` SDK client (lib/stripe.ts) — no new Stripe logic, just a provider-neutral shape around calls already used elsewhere in this codebase. */
export const stripeProvider: PaymentProvider = {
  name: "stripe",

  async createCustomer({ email, name }) {
    const customer = await stripe.customers.create({ email, name });
    return { providerCustomerId: customer.id };
  },

  async attachPaymentMethod({ providerCustomerId, providerPaymentMethodId }): Promise<ProviderPaymentMethod> {
    await stripe.paymentMethods.attach(providerPaymentMethodId, { customer: providerCustomerId });
    return { providerPaymentMethodId };
  },

  async createPayment({ amount, currency, providerCustomerId, metadata, idempotencyKey }) {
    const pi = await stripe.paymentIntents.create(
      { amount, currency, customer: providerCustomerId, automatic_payment_methods: { enabled: true }, metadata },
      { idempotencyKey },
    );
    return { providerRef: pi.id, status: mapIntentStatus(pi.status), clientSecret: pi.client_secret ?? undefined };
  },

  async verifyPayment(providerRef) {
    const pi = await stripe.paymentIntents.retrieve(providerRef);
    return { providerRef: pi.id, status: mapIntentStatus(pi.status) === "SUCCEEDED" ? "SUCCEEDED" : mapIntentStatus(pi.status) === "FAILED" ? "FAILED" : "PENDING", amount: pi.amount, currency: pi.currency };
  },

  async createAuthorisation({ amount, currency, providerCustomerId, metadata, idempotencyKey }) {
    const pi = await stripe.paymentIntents.create(
      { amount, currency, customer: providerCustomerId, capture_method: "manual", automatic_payment_methods: { enabled: true }, metadata },
      { idempotencyKey },
    );
    return { providerRef: pi.id, status: mapIntentStatus(pi.status), clientSecret: pi.client_secret ?? undefined };
  },

  async captureAuthorisation(providerRef, amount?: MinorAmount) {
    const pi = await stripe.paymentIntents.capture(providerRef, amount != null ? { amount_to_capture: amount } : undefined);
    return { providerRef: pi.id, status: pi.status === "succeeded" ? "SUCCEEDED" : "FAILED", amount: pi.amount, currency: pi.currency };
  },

  async cancelAuthorisation(providerRef) {
    await stripe.paymentIntents.cancel(providerRef);
  },

  async chargeSavedPaymentMethod({ providerCustomerId, providerPaymentMethodId, amount, currency, metadata, idempotencyKey }) {
    const pi = await stripe.paymentIntents.create(
      { amount, currency, customer: providerCustomerId, payment_method: providerPaymentMethodId, off_session: true, confirm: true, metadata },
      { idempotencyKey },
    );
    return { providerRef: pi.id, status: mapIntentStatus(pi.status), clientSecret: pi.client_secret ?? undefined };
  },

  async createRefund({ providerRef, amount, idempotencyKey }): Promise<ProviderRefundResult> {
    const refund = await stripe.refunds.create({ payment_intent: providerRef, amount }, { idempotencyKey });
    return { providerRefundRef: refund.id, status: refund.status === "succeeded" ? "SUCCEEDED" : refund.status === "failed" ? "FAILED" : "PENDING" };
  },

  async verifyRefund(providerRefundRef) {
    const refund = await stripe.refunds.retrieve(providerRefundRef);
    return { providerRefundRef: refund.id, status: refund.status === "succeeded" ? "SUCCEEDED" : refund.status === "failed" ? "FAILED" : "PENDING" };
  },

  async createTransfer({ destinationAccountRef, amount, currency, idempotencyKey }): Promise<ProviderTransferResult> {
    const transfer = await stripe.transfers.create({ amount, currency, destination: destinationAccountRef }, { idempotencyKey });
    return { providerTransferRef: transfer.id, status: "SUCCEEDED" };
  },

  async verifyTransfer(providerTransferRef) {
    const transfer = await stripe.transfers.retrieve(providerTransferRef);
    return { providerTransferRef: transfer.id, status: "SUCCEEDED" };
  },

  async retrieveTransaction(providerRef): Promise<ProviderVerifyResult> {
    return this.verifyPayment(providerRef);
  },

  processWebhook(rawBody, signature): ProviderWebhookEvent {
    try {
      const event = stripe.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
      return { providerEventId: event.id, type: event.type, raw: event };
    } catch {
      throw new AppError("Invalid Stripe webhook signature", 400);
    }
  },

  async reconcileTransactions({ periodStart, periodEnd, localRecords }) {
    const localByRef = new Map(localRecords.map((r) => [r.ref, r.amount]));
    const seenAtProvider = new Set<string>();
    const missingLocally: { ref: string; amount: number }[] = [];
    const amountMismatches: { ref: string; localAmount: number; providerAmount: number }[] = [];
    let startingAfter: string | undefined;
    // Stripe's list API paginates 100 at a time — walk the whole period.
    for (;;) {
      const page = await stripe.paymentIntents.list({
        created: { gte: Math.floor(periodStart.getTime() / 1000), lte: Math.floor(periodEnd.getTime() / 1000) },
        limit: 100,
        starting_after: startingAfter,
      });
      for (const pi of page.data) {
        if (pi.status !== "succeeded") continue;
        seenAtProvider.add(pi.id);
        const localAmount = localByRef.get(pi.id);
        if (localAmount === undefined) {
          missingLocally.push({ ref: pi.id, amount: pi.amount });
        } else if (localAmount !== pi.amount) {
          amountMismatches.push({ ref: pi.id, localAmount, providerAmount: pi.amount });
        }
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1]?.id;
    }
    // Only meaningful for refs Stripe would have returned in this period —
    // a local record outside [periodStart, periodEnd] will be reported
    // missing even though it legitimately exists outside the queried window.
    const missingAtProvider = localRecords.filter((r) => !seenAtProvider.has(r.ref)).map((r) => r.ref);
    return { missingAtProvider, missingLocally, amountMismatches };
  },
};
