import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/stripe", () => ({
  stripe: {
    paymentIntents: {
      create: vi.fn().mockResolvedValue({ id: "pi_1", status: "requires_action", client_secret: "secret_1" }),
      retrieve: vi.fn().mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 1000, currency: "gbp" }),
    },
    refunds: { create: vi.fn().mockResolvedValue({ id: "re_1", status: "succeeded" }) },
  },
}));

vi.mock("../lib/paystack", () => ({
  paystack: {
    initializeTransaction: vi.fn().mockResolvedValue({ reference: "ref-1", authorization_url: "https://paystack.test/pay/ref-1", access_code: "code" }),
    verifyTransaction: vi.fn().mockResolvedValue({ status: "success", reference: "ref-1", amount: 5000, currency: "NGN" }),
  },
}));

import { stripeProvider } from "../modules/payments/provider/stripe-provider";
import { paystackProvider } from "../modules/payments/provider/paystack-provider";
import { paymentProviderFactory } from "../modules/payments/provider/payment-provider.factory";

describe("stripeProvider", () => {
  it("createPayment maps requires_action correctly", async () => {
    const result = await stripeProvider.createPayment({ amount: 1000, currency: "gbp", idempotencyKey: "k1" });
    expect(result).toEqual({ providerRef: "pi_1", status: "REQUIRES_ACTION", clientSecret: "secret_1" });
  });

  it("verifyPayment maps succeeded correctly", async () => {
    const result = await stripeProvider.verifyPayment("pi_1");
    expect(result).toEqual({ providerRef: "pi_1", status: "SUCCEEDED", amount: 1000, currency: "gbp" });
  });

  it("createRefund maps succeeded correctly", async () => {
    const result = await stripeProvider.createRefund({ providerRef: "pi_1", idempotencyKey: "k2" });
    expect(result).toEqual({ providerRefundRef: "re_1", status: "SUCCEEDED" });
  });
});

describe("paystackProvider", () => {
  it("createPayment requires metadata.buyerEmail and returns a redirect URL", async () => {
    const result = await paystackProvider.createPayment({ amount: 5000, currency: "NGN", idempotencyKey: "ref-1", metadata: { buyerEmail: "buyer@test.com" } });
    expect(result.status).toBe("PENDING");
    expect(result.redirectUrl).toBe("https://paystack.test/pay/ref-1");
  });

  it("createPayment throws without buyerEmail rather than silently failing later", async () => {
    await expect(paystackProvider.createPayment({ amount: 5000, currency: "NGN", idempotencyKey: "ref-2" })).rejects.toThrow(/buyerEmail/);
  });

  it("unsupported operations (createCustomer, authorisation flow) fail loudly, not silently", async () => {
    await expect(paystackProvider.createCustomer({ email: "a@b.com" })).rejects.toThrow(/does not support/);
    await expect(paystackProvider.createAuthorisation({ amount: 100, currency: "NGN", idempotencyKey: "k" })).rejects.toThrow(/does not support/);
  });

  it("verifyTransfer and reconcileTransactions are honestly unimplemented, not faked", async () => {
    await expect(paystackProvider.verifyTransfer("tr_1")).rejects.toThrow(/not yet implemented/);
    await expect(paystackProvider.reconcileTransactions({ periodStart: new Date(), periodEnd: new Date(), localRecords: [] })).rejects.toThrow(/not yet implemented/);
  });
});

describe("paymentProviderFactory", () => {
  it("routes Nigeria/Ghana vendors to Paystack, everyone else to Stripe", () => {
    expect(paymentProviderFactory.forVendorCountry("Nigeria").name).toBe("paystack");
    expect(paymentProviderFactory.forVendorCountry("NG").name).toBe("paystack");
    expect(paymentProviderFactory.forVendorCountry("Ghana").name).toBe("paystack");
    expect(paymentProviderFactory.forVendorCountry("United Kingdom").name).toBe("stripe");
    expect(paymentProviderFactory.forVendorCountry(null).name).toBe("stripe");
  });
});
