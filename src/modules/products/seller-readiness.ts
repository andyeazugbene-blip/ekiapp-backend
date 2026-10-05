import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/**
 * Handbook 14.6 / gap B15: a product is NOT purchasable when its seller cannot
 * be paid. Authoritative columns: Vendor.verificationStatus / isSuspended /
 * closedAt / stripeChargesEnabled (see vendors/vendor-provider-readiness.ts).
 *
 * Readiness rule:
 *  - vendor must be VERIFIED, not suspended, not closed; and
 *  - Stripe vendors (a stripeAccountId exists) need stripeChargesEnabled;
 *  - vendors with NO Stripe account are on another provider (Paystack): ready
 *    only if they hold a Paystack transfer recipient (VendorBankAccount with
 *    paystackRecipientCode). Anything else = not ready.
 *
 * Rollout switch: SELLER_PAYMENT_READINESS_GATE=true|1|on enables the gate.
 * Default: OFF. Vendor Stripe capability flags were only ever synced by polling
 * before the account.updated webhook was wired, so enabling blindly could block
 * vendors who are in fact able to receive payment. Enable it in production only
 * after Admin > Vendors > "Payment ready" shows the flags are accurate.
 */
export function isSellerReadinessGateEnabled(): boolean {
  const raw = (process.env.SELLER_PAYMENT_READINESS_GATE ?? "").trim().toLowerCase();
  if (["false", "0", "off", "no"].includes(raw)) return false;
  if (["true", "1", "on", "yes"].includes(raw)) return true;
  return false;
}

export const SELLER_NOT_READY_CODE = "SELLER_PAYMENT_NOT_READY";

export type SellerNotReadyReason =
  | "VENDOR_NOT_VERIFIED"
  | "VENDOR_SUSPENDED"
  | "VENDOR_CLOSED"
  | "SELLER_PAYMENTS_NOT_ENABLED";

export interface SellerReadinessInput {
  verificationStatus: string;
  isSuspended: boolean;
  closedAt: Date | null;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  bankAccounts?: Array<{ paystackRecipientCode: string | null }>;
}

export const SELLER_READINESS_SELECT = {
  id: true,
  verificationStatus: true,
  isSuspended: true,
  closedAt: true,
  stripeAccountId: true,
  stripeChargesEnabled: true,
  bankAccounts: { select: { paystackRecipientCode: true } },
} as const;

export const SELLER_REASON_MESSAGES: Record<SellerNotReadyReason, string> = {
  VENDOR_NOT_VERIFIED: "Seller is not verified",
  VENDOR_SUSPENDED: "Seller is suspended",
  VENDOR_CLOSED: "Seller account is closed",
  SELLER_PAYMENTS_NOT_ENABLED: "Seller payment setup incomplete",
};

export function assessSellerReadiness(v: SellerReadinessInput): { ready: boolean; reason: SellerNotReadyReason | null } {
  if (v.closedAt) return { ready: false, reason: "VENDOR_CLOSED" };
  if (v.isSuspended) return { ready: false, reason: "VENDOR_SUSPENDED" };
  if (v.verificationStatus !== "VERIFIED") return { ready: false, reason: "VENDOR_NOT_VERIFIED" };
  if (v.stripeAccountId) {
    return v.stripeChargesEnabled ? { ready: true, reason: null } : { ready: false, reason: "SELLER_PAYMENTS_NOT_ENABLED" };
  }
  const paystackReady = (v.bankAccounts ?? []).some((b) => Boolean(b.paystackRecipientCode));
  return paystackReady ? { ready: true, reason: null } : { ready: false, reason: "SELLER_PAYMENTS_NOT_ENABLED" };
}

/** Prisma `where` for Vendor mirroring assessSellerReadiness (buyer feeds). */
export function purchasableVendorWhere(): Prisma.VendorWhereInput {
  return {
    verificationStatus: "VERIFIED",
    isSuspended: false,
    closedAt: null,
    OR: [
      { stripeAccountId: { not: null }, stripeChargesEnabled: true },
      { stripeAccountId: null, bankAccounts: { some: { paystackRecipientCode: { not: null } } } },
    ],
  };
}

/** Throws SELLER_PAYMENT_NOT_READY (409) if any vendor is not purchasable. No-op when the gate is off. */
export async function assertVendorsPurchasable(
  vendorIds: string[],
  client: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<void> {
  if (!isSellerReadinessGateEnabled() || vendorIds.length === 0) return;
  const unique = Array.from(new Set(vendorIds));
  const vendors = await client.vendor.findMany({ where: { id: { in: unique } }, select: SELLER_READINESS_SELECT });
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const blocked: Array<{ vendorId: string; reason: SellerNotReadyReason }> = [];
  for (const id of unique) {
    const v = byId.get(id);
    if (!v) {
      blocked.push({ vendorId: id, reason: "VENDOR_NOT_VERIFIED" });
      continue;
    }
    const a = assessSellerReadiness(v);
    if (!a.ready && a.reason) blocked.push({ vendorId: id, reason: a.reason });
  }
  if (blocked.length > 0) {
    throw new AppError(
      "This seller can't accept payments right now, so their products can't be purchased yet.",
      409,
      { blocked },
      SELLER_NOT_READY_CODE,
    );
  }
}
