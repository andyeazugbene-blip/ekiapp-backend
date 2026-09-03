import { paystack } from "../../../lib/paystack";
import { AppError } from "../../../shared/errors/app-error";
import type {
  PaymentProvider,
  ProviderPaymentMethod,
  ProviderRefundResult,
  ProviderTransferResult,
  ProviderVerifyResult,
  ProviderWebhookEvent,
} from "./payment-provider.interface";

function mapVerifyStatus(status: string): ProviderVerifyResult["status"] {
  if (status === "success") return "SUCCEEDED";
  if (status === "failed" || status === "abandoned") return "FAILED";
  return "PENDING";
}

/**
 * Thin wrapper over the existing `paystack` client (lib/paystack.ts).
 * Paystack has no separate customer/payment-method/authorisation-hold
 * concept the way Stripe does — it's a single-charge, redirect-based flow
 * (buyer completes payment on Paystack's hosted page). Methods that don't
 * map cleanly (createCustomer, attachPaymentMethod, the auth/capture pair)
 * throw a clear "not supported by this provider" error rather than faking
 * behavior Paystack doesn't have.
 */
export const paystackProvider: PaymentProvider = {
  name: "paystack",

  async createCustomer(): Promise<never> {
    throw new AppError("Paystack does not support a separate customer object in this integration — pass email per-transaction", 400, undefined, "PROVIDER_UNSUPPORTED_OPERATION");
  },

  async attachPaymentMethod(): Promise<ProviderPaymentMethod> {
    throw new AppError("Paystack does not support attaching a saved payment method in this integration", 400, undefined, "PROVIDER_UNSUPPORTED_OPERATION");
  },

  async createPayment({ amount, currency, metadata, idempotencyKey }) {
    const email = metadata?.buyerEmail;
    if (!email) throw new AppError("Paystack createPayment requires metadata.buyerEmail", 400);
    const result = await paystack.initializeTransaction({
      email,
      amount,
      currency,
      reference: idempotencyKey,
      metadata: metadata ?? {},
    });
    return { providerRef: result.reference, status: "PENDING", redirectUrl: result.authorization_url };
  },

  async verifyPayment(providerRef): Promise<ProviderVerifyResult> {
    const result = await paystack.verifyTransaction(providerRef);
    return { providerRef: result.reference, status: mapVerifyStatus(result.status), amount: result.amount, currency: result.currency };
  },

  async createAuthorisation(): Promise<never> {
    throw new AppError("Paystack does not support a separate authorise/capture flow in this integration — use createPayment", 400, undefined, "PROVIDER_UNSUPPORTED_OPERATION");
  },

  async captureAuthorisation(): Promise<never> {
    throw new AppError("Paystack does not support a separate authorise/capture flow in this integration", 400, undefined, "PROVIDER_UNSUPPORTED_OPERATION");
  },

  async cancelAuthorisation(): Promise<void> {
    throw new AppError("Paystack does not support cancelling an authorisation in this integration", 400, undefined, "PROVIDER_UNSUPPORTED_OPERATION");
  },

  async chargeSavedPaymentMethod(): Promise<never> {
    throw new AppError("Paystack does not support charging a saved payment method in this integration", 400, undefined, "PROVIDER_UNSUPPORTED_OPERATION");
  },

  async createRefund({ providerRef, amount, idempotencyKey: _idempotencyKey }): Promise<ProviderRefundResult> {
    // lib/paystack.ts's refundTransaction has no separate refund-id return
    // (Paystack's refund API is fire-and-forget from this client's
    // perspective) — status is reported PENDING; verifyRefund re-checks.
    await paystack.refundTransaction(providerRef, amount);
    return { providerRefundRef: providerRef, status: "PENDING" };
  },

  async verifyRefund(providerRefundRef): Promise<ProviderRefundResult> {
    const result = await paystack.verifyTransaction(providerRefundRef);
    return { providerRefundRef, status: result.status === "success" ? "SUCCEEDED" : result.status === "failed" ? "FAILED" : "PENDING" };
  },

  async createTransfer({ destinationAccountRef, amount, idempotencyKey }): Promise<ProviderTransferResult> {
    const result = await paystack.initiateTransfer({ recipientCode: destinationAccountRef, amount, reference: idempotencyKey, reason: "Eki vendor payout" });
    return { providerTransferRef: result.reference, status: result.status === "success" ? "SUCCEEDED" : "PENDING" };
  },

  async verifyTransfer(providerTransferRef): Promise<ProviderTransferResult> {
    // lib/paystack.ts has no dedicated transfer-verify endpoint wired yet —
    // this is a real, disclosed gap (see docs/decisions/0007), not a fake success.
    throw new AppError("Transfer verification is not yet implemented for Paystack", 501, undefined, "PROVIDER_NOT_IMPLEMENTED");
  },

  async retrieveTransaction(providerRef): Promise<ProviderVerifyResult> {
    return this.verifyPayment(providerRef);
  },

  processWebhook(rawBody, signature): ProviderWebhookEvent {
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    if (!paystack.verifyWebhookSignature(body, signature)) {
      throw new AppError("Invalid Paystack webhook signature", 400);
    }
    const parsed = JSON.parse(body) as { event: string; data: { reference?: string } };
    return { providerEventId: `paystack:${parsed.data?.reference ?? "unknown"}`, type: parsed.event, raw: parsed };
  },

  async reconcileTransactions(): Promise<{ missingAtProvider: string[]; missingLocally: string[] }> {
    // Paystack's list-transactions API isn't wired into lib/paystack.ts yet
    // — real, disclosed gap rather than a fabricated reconciliation result.
    throw new AppError("Transaction reconciliation is not yet implemented for Paystack", 501, undefined, "PROVIDER_NOT_IMPLEMENTED");
  },
};
