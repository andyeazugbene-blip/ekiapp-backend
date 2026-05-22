import crypto from "crypto";

import { logger } from "./logger";

/**
 * Paystack API client — lightweight wrapper (no SDK dependency).
 * Uses fetch against https://api.paystack.co.
 */

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY ?? "";
const PAYSTACK_BASE = "https://api.paystack.co";

if (!PAYSTACK_SECRET_KEY) {
  logger.warn("PAYSTACK_SECRET_KEY not set — Paystack features disabled");
}

async function paystackFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; message?: string }> {
  const url = `${PAYSTACK_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  return {
    ok: res.ok && json?.status === true,
    status: res.status,
    data: (json?.data as T) ?? null,
    message: (json?.message as string) ?? undefined,
  };
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface PaystackInitializeResponse {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackVerifyResponse {
  id: number;
  status: "success" | "failed" | "abandoned";
  reference: string;
  amount: number;
  currency: string;
  channel: string;
  paid_at: string | null;
  customer: { email: string; id: number };
  metadata: Record<string, unknown> | null;
}

export interface PaystackTransferRecipientResponse {
  recipient_code: string;
  name: string;
  type: string;
}

export interface PaystackTransferResponse {
  id: number;
  reference: string;
  status: string;
  amount: number;
  currency: string;
}

export interface PaystackBankListItem {
  name: string;
  slug: string;
  code: string;
  country: string;
  currency: string;
}

export interface PaystackResolveAccountResponse {
  account_number: string;
  account_name: string;
  bank_id: number;
}

// ─── API Methods ──────────────────────────────────────────────────────────

export const paystack = {
  isConfigured(): boolean {
    return !!PAYSTACK_SECRET_KEY;
  },

  /**
   * Initialize a transaction — returns checkout URL for buyer.
   */
  async initializeTransaction(params: {
    email: string;
    amount: number; // in kobo/pesewas (smallest unit)
    currency: string; // NGN or GHS
    reference: string;
    callbackUrl?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PaystackInitializeResponse> {
    const res = await paystackFetch<PaystackInitializeResponse>("POST", "/transaction/initialize", {
      email: params.email,
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      reference: params.reference,
      callback_url: params.callbackUrl,
      metadata: params.metadata,
    });

    if (!res.ok || !res.data) {
      logger.error("Paystack initialize failed", { message: res.message, status: res.status });
      throw new Error(`Paystack initialize failed: ${res.message ?? "Unknown error"}`);
    }

    return res.data;
  },

  /**
   * Verify a transaction by reference.
   */
  async verifyTransaction(reference: string): Promise<PaystackVerifyResponse> {
    const res = await paystackFetch<PaystackVerifyResponse>("GET", `/transaction/verify/${encodeURIComponent(reference)}`);

    if (!res.ok || !res.data) {
      throw new Error(`Paystack verify failed: ${res.message ?? "Unknown error"}`);
    }

    return res.data;
  },

  /**
   * Create a transfer recipient (vendor's bank account for payout).
   */
  async createTransferRecipient(params: {
    name: string;
    accountNumber: string;
    bankCode: string;
    currency: string;
  }): Promise<PaystackTransferRecipientResponse> {
    const res = await paystackFetch<PaystackTransferRecipientResponse>("POST", "/transferrecipient", {
      type: "nuban",
      name: params.name,
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency: params.currency.toUpperCase(),
    });

    if (!res.ok || !res.data) {
      throw new Error(`Paystack create recipient failed: ${res.message ?? "Unknown error"}`);
    }

    return res.data;
  },

  /**
   * Initiate a transfer (payout to vendor).
   */
  async initiateTransfer(params: {
    amount: number;
    recipientCode: string;
    reference: string;
    reason?: string;
  }): Promise<PaystackTransferResponse> {
    const res = await paystackFetch<PaystackTransferResponse>("POST", "/transfer", {
      source: "balance",
      amount: params.amount,
      recipient: params.recipientCode,
      reference: params.reference,
      reason: params.reason ?? "Eki marketplace payout",
    });

    if (!res.ok || !res.data) {
      throw new Error(`Paystack transfer failed: ${res.message ?? "Unknown error"}`);
    }

    return res.data;
  },

  /**
   * Resolve account number — verify it belongs to the right person.
   */
  async resolveAccountNumber(accountNumber: string, bankCode: string): Promise<PaystackResolveAccountResponse> {
    const res = await paystackFetch<PaystackResolveAccountResponse>(
      "GET",
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );

    if (!res.ok || !res.data) {
      throw new Error(`Paystack resolve account failed: ${res.message ?? "Unknown error"}`);
    }

    return res.data;
  },

  /**
   * Refund a transaction.
   */
  async refundTransaction(reference: string, amount?: number): Promise<void> {
    const body: Record<string, unknown> = { transaction: reference };
    if (amount) body.amount = amount;

    const res = await paystackFetch("POST", "/refund", body);
    if (!res.ok) {
      throw new Error(`Paystack refund failed: ${res.message ?? "Unknown error"}`);
    }
  },

  /**
   * Verify webhook signature (HMAC SHA-512).
   */
  verifyWebhookSignature(body: string | Buffer, signature: string): boolean {
    if (!PAYSTACK_SECRET_KEY) return false;
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(typeof body === "string" ? body : body.toString("utf-8"))
      .digest("hex");
    return hash === signature;
  },
};
