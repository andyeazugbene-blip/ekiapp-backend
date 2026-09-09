/**
 * P0-2 regression suite — vendor payout safety.
 *
 * Root bug: adminMarkPaid() used to commit status=PAID, decrement the
 * wallet, and write the ledger entry BEFORE the real Stripe Connect
 * transfer was even attempted. A thrown/failed transfer left the request
 * permanently "paid" with no money actually moved and no recovery path.
 *
 * Fix (payouts.service.ts): for Stripe-method payouts, APPROVED/ON_HOLD/
 * PROCESSING -> PROCESSING (wallet debit + ledger entry posted exactly once,
 * on the real first APPROVED transition) -> real Stripe transfer with a
 * deterministic idempotency key -> PAID only on confirmed success, or
 * ON_HOLD (never silently retried, never assumed paid) on any failure.
 * Manual (bank/PayPal) payout methods are unchanged — no provider call of
 * ours to fail there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    payoutRequest: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    payoutMethod: { findUnique: vi.fn() },
    vendor: { findUnique: vi.fn() },
    wallet: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    walletTransaction: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { transfers: { create: vi.fn() } },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

vi.mock("../lib/email-queue", () => ({
  enqueueEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { notificationsService } from "../modules/notifications/notifications.service";
import { payoutsService } from "../modules/payouts/payouts.service";

const m = vi.mocked(prisma, true);
const mTransferCreate = vi.mocked(stripe.transfers.create);

const STRIPE_METHOD = { id: "method-1", type: "OTHER", details: { provider: "stripe" } };
// Superset of every field any code path along adminMarkPaid's success flow
// reads from a vendor row (readiness check, notification recipient lookup,
// and the receipt-email lookup) — these mocks don't apply Prisma `select`.
const VENDOR_READY = {
  stripeAccountId: "acct_1",
  stripePayoutsEnabled: true,
  userId: "vendor-user-1",
  storeName: "Test Store",
  user: { email: "vendor@example.com", name: "Vendor Person" },
};

function approvedPayout(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "payout-1",
    vendorId: "vendor-1",
    payoutMethodId: "method-1",
    amount: 10000,
    netAmount: 9500,
    withdrawalFeeAmount: 500,
    currency: "GBP",
    status: "APPROVED",
    notes: null,
    holdReason: null,
    stripeTransferId: null,
    ...overrides,
  };
}

// $transaction runs the callback against `m` itself (the same mocked client) —
// matches the pattern already used across this codebase's other test files.
function wireTransaction() {
  m.$transaction.mockImplementation(async (cb: any) => cb(m));
}

beforeEach(() => {
  vi.clearAllMocks();
  wireTransaction();
  m.payoutMethod.findUnique.mockResolvedValue(STRIPE_METHOD as never);
  m.vendor.findUnique.mockResolvedValue(VENDOR_READY as never);
  m.wallet.findUniqueOrThrow.mockResolvedValue({ id: "wallet-1", vendorId: "vendor-1", availableBalance: 50000, currency: "GBP" } as never);
  m.walletTransaction.create.mockResolvedValue({} as never);
});

describe("payoutsService.adminMarkPaid — Stripe path safety (P0-2)", () => {
  it("1. successful payout: PROCESSING then PAID only after Stripe confirms, wallet debited once, ledger posted once", async () => {
    const payout = approvedPayout();
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never); // initial lookup
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never); // APPROVED -> PROCESSING
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.wallet.updateMany.mockResolvedValue({ count: 1 } as never);
    mTransferCreate.mockResolvedValue({ id: "tr_123" } as never);
    m.payoutRequest.update.mockResolvedValue({ ...payout, status: "PAID", stripeTransferId: "tr_123" } as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");

    expect(result.status).toBe("PAID");
    expect(result.stripeTransferId).toBe("tr_123");
    // Wallet debited exactly once.
    expect(m.wallet.updateMany).toHaveBeenCalledTimes(1);
    expect(m.wallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { vendorId: "vendor-1", availableBalance: { gte: 10000 } },
      data: { availableBalance: { decrement: 10000 } },
    }));
    // Ledger entry posted exactly once.
    expect(m.walletTransaction.create).toHaveBeenCalledTimes(1);
    // Real transfer, real deterministic idempotency key.
    expect(mTransferCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9500, currency: "gbp", destination: "acct_1" }),
      { idempotencyKey: "payout-transfer:payout-1" },
    );
    // Notified only after confirmed PAID.
    expect(notificationsService.enqueue).toHaveBeenCalled();
  });

  it("2. Stripe failure (decline): moves to ON_HOLD with the reason preserved, never PAID, wallet already-debited amount is NOT reversed", async () => {
    const payout = approvedPayout();
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.wallet.updateMany.mockResolvedValue({ count: 1 } as never);
    mTransferCreate.mockRejectedValue(new Error("Your card was declined."));
    m.payoutRequest.update.mockResolvedValue({ ...payout, status: "ON_HOLD", holdReason: "Transfer failed or could not be confirmed: Your card was declined." } as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");

    expect(result.status).toBe("ON_HOLD");
    expect(result.holdReason).toContain("declined");
    // The debit already happened as part of committing to this attempt — it
    // is not reversed automatically; an admin resolves ON_HOLD explicitly.
    expect(m.wallet.updateMany).toHaveBeenCalledTimes(1);
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });

  it("3. Stripe timeout/network error: treated identically to a failure — ON_HOLD, never assumed paid, never assumed definitively failed", async () => {
    const payout = approvedPayout();
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.wallet.updateMany.mockResolvedValue({ count: 1 } as never);
    mTransferCreate.mockRejectedValue(Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" }));
    m.payoutRequest.update.mockResolvedValue({ ...payout, status: "ON_HOLD", holdReason: "Transfer failed or could not be confirmed: ETIMEDOUT" } as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");

    expect(result.status).toBe("ON_HOLD");
    expect(result.status).not.toBe("PAID");
  });

  it("4. duplicate request: already-PAID payout returns the existing record as a no-op, no second transfer, no second debit", async () => {
    const payout = approvedPayout({ status: "PAID", stripeTransferId: "tr_already" });
    m.payoutRequest.findUnique.mockResolvedValue(payout as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");

    expect(result.status).toBe("PAID");
    expect(mTransferCreate).not.toHaveBeenCalled();
    expect(m.wallet.updateMany).not.toHaveBeenCalled();
    expect(m.payoutRequest.updateMany).not.toHaveBeenCalled();
  });

  it("5. concurrent payout requests: a losing racer's atomic transition matches zero rows and is rejected, never double-processes", async () => {
    const payout = approvedPayout();
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);
    // Someone else already moved it to PROCESSING between our findUnique and our updateMany.
    m.payoutRequest.updateMany.mockResolvedValue({ count: 0 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);

    await expect(payoutsService.adminMarkPaid("admin-1", "payout-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(mTransferCreate).not.toHaveBeenCalled();
    expect(m.wallet.updateMany).not.toHaveBeenCalled();
  });

  it("6. retry after failure: ON_HOLD -> succeeds this time -> PAID, wallet is NOT debited a second time", async () => {
    const onHold = approvedPayout({ status: "ON_HOLD", holdReason: "Transfer failed or could not be confirmed: prior error" });
    m.payoutRequest.findUnique.mockResolvedValueOnce(onHold as never);
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never); // ON_HOLD -> PROCESSING
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...onHold, status: "PROCESSING" } as never);
    mTransferCreate.mockResolvedValue({ id: "tr_retry_success" } as never);
    m.payoutRequest.update.mockResolvedValue({ ...onHold, status: "PAID", stripeTransferId: "tr_retry_success", holdReason: null } as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");

    expect(result.status).toBe("PAID");
    // Not the first attempt — no wallet debit, no new ledger entry this time.
    expect(m.wallet.updateMany).not.toHaveBeenCalled();
    expect(m.walletTransaction.create).not.toHaveBeenCalled();
    // Same deterministic idempotency key as any other attempt for this payout.
    expect(mTransferCreate).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "payout-transfer:payout-1" });
  });

  it("7. provider already succeeded but local request had timed out: retrying replays the identical idempotency key so Stripe cannot create a real duplicate transfer", async () => {
    const onHold = approvedPayout({ status: "ON_HOLD" });
    m.payoutRequest.findUnique.mockResolvedValueOnce(onHold as never);
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...onHold, status: "PROCESSING" } as never);
    // Stripe's own idempotency guarantee: replaying the same key returns the
    // ORIGINAL transfer object, not a new one — simulated here directly.
    mTransferCreate.mockResolvedValue({ id: "tr_original_that_actually_succeeded" } as never);
    m.payoutRequest.update.mockResolvedValue({ ...onHold, status: "PAID", stripeTransferId: "tr_original_that_actually_succeeded" } as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");

    expect(result.stripeTransferId).toBe("tr_original_that_actually_succeeded");
    expect(mTransferCreate).toHaveBeenCalledTimes(1);
    expect(mTransferCreate.mock.calls[0][1]).toEqual({ idempotencyKey: "payout-transfer:payout-1" });
  });

  it("8. DB update failure after provider success: status is left at PROCESSING (never falsely PAID), and a later retry safely completes via the same idempotency key", async () => {
    const payout = approvedPayout();
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.wallet.updateMany.mockResolvedValueOnce({ count: 1 } as never); // genuine first attempt — debited once, here
    mTransferCreate.mockResolvedValueOnce({ id: "tr_success_but_db_write_failed" } as never);
    m.payoutRequest.update.mockRejectedValueOnce(new Error("connection reset"));

    // The transfer succeeded; our own write to record PAID failed. The
    // function must not swallow this into a false ON_HOLD/PAID — it
    // surfaces the error, leaving the row at PROCESSING (already committed
    // above), which is itself a valid retry-starting state.
    await expect(payoutsService.adminMarkPaid("admin-1", "payout-1")).rejects.toThrow("connection reset");

    // Retry: status is now PROCESSING; the same idempotency key replays and
    // Stripe returns the same (already-succeeded) transfer; this time the
    // DB write succeeds.
    m.payoutRequest.findUnique.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.payoutRequest.updateMany.mockResolvedValueOnce({ count: 1 } as never); // PROCESSING -> PROCESSING (re-entrant, no-op status-wise)
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    mTransferCreate.mockResolvedValueOnce({ id: "tr_success_but_db_write_failed" } as never);
    m.payoutRequest.update.mockResolvedValueOnce({ ...payout, status: "PAID", stripeTransferId: "tr_success_but_db_write_failed" } as never);

    const retried = await payoutsService.adminMarkPaid("admin-1", "payout-1");
    expect(retried.status).toBe("PAID");
    // Debited exactly once total — on the original (genuine first) attempt,
    // never again on the retry that followed the DB-write crash.
    expect(m.wallet.updateMany).toHaveBeenCalledTimes(1);
  });

  it("9. payout not found: rejected with 404, no transfer attempted", async () => {
    m.payoutRequest.findUnique.mockResolvedValue(null as never);
    await expect(payoutsService.adminMarkPaid("admin-1", "missing-payout")).rejects.toMatchObject({ statusCode: 404 });
    expect(mTransferCreate).not.toHaveBeenCalled();
  });

  it("9b. cannot mark paid from PENDING or REJECTED — must be APPROVED, ON_HOLD, or PROCESSING", async () => {
    const pending = approvedPayout({ status: "PENDING" });
    m.payoutRequest.findUnique.mockResolvedValueOnce(pending as never);
    await expect(payoutsService.adminMarkPaid("admin-1", "payout-1")).rejects.toMatchObject({ statusCode: 400 });
    expect(mTransferCreate).not.toHaveBeenCalled();

    const rejected = approvedPayout({ status: "REJECTED" });
    m.payoutRequest.findUnique.mockResolvedValueOnce(rejected as never);
    await expect(payoutsService.adminMarkPaid("admin-1", "payout-1")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("10. ledger consistency: exactly one WalletTransaction row exists per payout no matter how many attempts it takes to reach PAID", async () => {
    const payout = approvedPayout();
    // Attempt 1: fails.
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);
    m.payoutRequest.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.wallet.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    mTransferCreate.mockRejectedValueOnce(new Error("first attempt fails"));
    m.payoutRequest.update.mockResolvedValueOnce({ ...payout, status: "ON_HOLD" } as never);
    await payoutsService.adminMarkPaid("admin-1", "payout-1");

    // Attempt 2 (retry): succeeds.
    m.payoutRequest.findUnique.mockResolvedValueOnce({ ...payout, status: "ON_HOLD" } as never);
    m.payoutRequest.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    mTransferCreate.mockResolvedValueOnce({ id: "tr_final" } as never);
    m.payoutRequest.update.mockResolvedValueOnce({ ...payout, status: "PAID", stripeTransferId: "tr_final" } as never);
    await payoutsService.adminMarkPaid("admin-1", "payout-1");

    // Across BOTH attempts combined: exactly one debit, exactly one ledger row.
    expect(m.wallet.updateMany).toHaveBeenCalledTimes(1);
    expect(m.walletTransaction.create).toHaveBeenCalledTimes(1);
  });

  it("insufficient balance on the real first attempt blocks the transfer entirely — never attempts Stripe with unbacked funds", async () => {
    const payout = approvedPayout();
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.wallet.updateMany.mockResolvedValue({ count: 0 } as never); // insufficient balance

    await expect(payoutsService.adminMarkPaid("admin-1", "payout-1")).rejects.toMatchObject({ statusCode: 400 });
    expect(mTransferCreate).not.toHaveBeenCalled();
  });

  it("vendor not Stripe-payout-ready: held for manual review instead of guessing", async () => {
    const payout = approvedPayout();
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValueOnce({ ...payout, status: "PROCESSING" } as never);
    m.wallet.updateMany.mockResolvedValue({ count: 1 } as never);
    m.vendor.findUnique.mockResolvedValueOnce({ stripeAccountId: null, stripePayoutsEnabled: false } as never);
    m.payoutRequest.update.mockResolvedValue({ ...payout, status: "ON_HOLD", holdReason: "Vendor's Stripe Connect account is not connected or not enabled for payouts." } as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");

    expect(result.status).toBe("ON_HOLD");
    expect(mTransferCreate).not.toHaveBeenCalled();
  });
});

describe("payoutsService.adminMarkPaid — manual (non-Stripe) payout methods are unchanged", () => {
  it("bank transfer: goes straight to PAID with admin-supplied proof, exactly as before — no PROCESSING/ON_HOLD involved", async () => {
    m.payoutMethod.findUnique.mockResolvedValue({ id: "method-2", type: "BANK_TRANSFER", details: {} } as never);
    const payout = approvedPayout({ payoutMethodId: "method-2" });
    m.payoutRequest.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUniqueOrThrow.mockResolvedValue({ ...payout, status: "PAID" } as never);
    m.wallet.updateMany.mockResolvedValue({ count: 1 } as never);
    m.payoutRequest.findUnique.mockResolvedValueOnce(payout as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1", "https://proof.example/receipt.pdf");

    expect(result.status).toBe("PAID");
    expect(mTransferCreate).not.toHaveBeenCalled();
    expect(m.wallet.updateMany).toHaveBeenCalledTimes(1);
  });

  it("bank transfer: rejects a repeat mark-paid on an already-PAID request", async () => {
    m.payoutMethod.findUnique.mockResolvedValue({ id: "method-2", type: "BANK_TRANSFER", details: {} } as never);
    m.payoutRequest.findUnique.mockResolvedValue(approvedPayout({ payoutMethodId: "method-2", status: "PAID" }) as never);

    const result = await payoutsService.adminMarkPaid("admin-1", "payout-1");
    expect(result.status).toBe("PAID");
    expect(m.payoutRequest.updateMany).not.toHaveBeenCalled();
  });
});
