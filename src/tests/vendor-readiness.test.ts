/**
 * Found 15 Oct 2026: a vendor whose Stripe charges/payouts are off has
 * every published product silently hidden from buyers (the gate, when
 * on), with zero indication in their own app why. This is the endpoint
 * that closes that gap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ vendorFindUnique: vi.fn() }));
vi.mock("../lib/prisma", () => ({ prisma: { vendor: { findUnique: m.vendorFindUnique } } }));

import { vendorStorePreviewService } from "../modules/vendors/vendor-store-preview.service";

const READY_VENDOR = { verificationStatus: "VERIFIED", isSuspended: false, closedAt: null, stripeAccountId: "acct_1", stripeChargesEnabled: true, bankAccounts: [] };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SELLER_PAYMENT_READINESS_GATE;
});
afterEach(() => {
  delete process.env.SELLER_PAYMENT_READINESS_GATE;
});

describe("vendorStorePreviewService.getReadiness", () => {
  it("reports ready (nothing to warn about) when the gate is off, regardless of actual Stripe state", async () => {
    m.vendorFindUnique.mockResolvedValue({ ...READY_VENDOR, stripeChargesEnabled: false });
    const result = await vendorStorePreviewService.getReadiness("user-1");
    expect(result).toEqual({ gateEnabled: false, ready: true, reason: null, message: null });
  });

  it("warns with a real reason when the gate is on and charges are off (the Yuvori case)", async () => {
    process.env.SELLER_PAYMENT_READINESS_GATE = "true";
    m.vendorFindUnique.mockResolvedValue({ ...READY_VENDOR, stripeChargesEnabled: false });
    const result = await vendorStorePreviewService.getReadiness("user-1");
    expect(result.gateEnabled).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("SELLER_PAYMENTS_NOT_ENABLED");
    expect(result.message).toMatch(/payment setup incomplete/i);
  });

  it("reports ready when the gate is on and the vendor is actually payment-ready", async () => {
    process.env.SELLER_PAYMENT_READINESS_GATE = "true";
    m.vendorFindUnique.mockResolvedValue(READY_VENDOR);
    const result = await vendorStorePreviewService.getReadiness("user-1");
    expect(result).toEqual({ gateEnabled: true, ready: true, reason: null, message: null });
  });

  it("refuses a caller with no vendor profile", async () => {
    m.vendorFindUnique.mockResolvedValue(null);
    await expect(vendorStorePreviewService.getReadiness("user-ghost")).rejects.toMatchObject({ statusCode: 403 });
  });
});
