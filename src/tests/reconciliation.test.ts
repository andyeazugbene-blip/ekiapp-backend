import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    checkout: { findMany: vi.fn() },
    campaignContribution: { findMany: vi.fn() },
    purchasedGiftCard: { findMany: vi.fn() },
    subscriptionPaymentAttempt: { findMany: vi.fn() },
    buyerWalletTransaction: { findMany: vi.fn() },
    reconciliationRun: { create: vi.fn(), update: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    reconciliationDifference: { createMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    ledgerAccount: { findMany: vi.fn() },
  },
}));

vi.mock("../modules/payments/provider/stripe-provider", () => ({
  stripeProvider: { name: "stripe", reconcileTransactions: vi.fn() },
}));

vi.mock("../modules/payments/provider/paystack-provider", () => ({
  paystackProvider: { name: "paystack", reconcileTransactions: vi.fn().mockRejectedValue(Object.assign(new Error("not yet implemented"), { statusCode: 501 })) },
}));

import { prisma } from "../lib/prisma";
import { stripeProvider } from "../modules/payments/provider/stripe-provider";
import { reconciliationService } from "../modules/ledger/reconciliation.service";

const m = vi.mocked(prisma, true);
const stripeReconcile = vi.mocked(stripeProvider.reconcileTransactions);

beforeEach(() => {
  vi.clearAllMocks();
  m.checkout.findMany.mockResolvedValue([]);
  m.campaignContribution.findMany.mockResolvedValue([]);
  m.purchasedGiftCard.findMany.mockResolvedValue([]);
  m.subscriptionPaymentAttempt.findMany.mockResolvedValue([]);
  m.buyerWalletTransaction.findMany.mockResolvedValue([]);
});

describe("reconciliationService.runReconciliation — real comparison, no fabricated data", () => {
  it("rejects a period longer than 31 days without ever calling the provider", async () => {
    await expect(
      reconciliationService.runReconciliation("stripe", new Date("2026-01-01"), new Date("2026-03-01")),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(stripeReconcile).not.toHaveBeenCalled();
    expect(m.reconciliationRun.create).not.toHaveBeenCalled();
  });

  it("rejects periodEnd before periodStart", async () => {
    await expect(
      reconciliationService.runReconciliation("stripe", new Date("2026-01-10"), new Date("2026-01-01")),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("gathers local records from every real Stripe PaymentIntent source — Checkout amount adjusted for wallet deduction, matching stripe.service.ts's own webhook formula", async () => {
    m.reconciliationRun.create.mockResolvedValue({ id: "run-1" } as never);
    m.checkout.findMany.mockResolvedValue([
      { id: "checkout-1", stripePaymentIntentId: "pi_checkout_1", totalAmount: 10000, metadata: { walletDeduction: 2000 } },
    ] as never);
    m.campaignContribution.findMany.mockResolvedValue([
      { id: "contrib-1", stripePaymentIntentId: "pi_cb_1", amount: 3000 },
    ] as never);
    stripeReconcile.mockResolvedValue({ missingAtProvider: [], missingLocally: [], amountMismatches: [] });
    m.reconciliationRun.update.mockResolvedValue({ id: "run-1", status: "COMPLETED", differences: [] } as never);

    await reconciliationService.runReconciliation("stripe", new Date("2026-01-01"), new Date("2026-01-15"));

    expect(stripeReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        localRecords: expect.arrayContaining([
          { ref: "pi_checkout_1", amount: 8000 }, // 10000 - 2000 wallet deduction
          { ref: "pi_cb_1", amount: 3000 },
        ]),
      }),
    );
  });

  it("creates a real ReconciliationDifference row for each missingAtProvider / missingLocally / amountMismatch, attributed to the correct business record", async () => {
    m.reconciliationRun.create.mockResolvedValue({ id: "run-2" } as never);
    m.checkout.findMany.mockResolvedValue([
      { id: "checkout-2", stripePaymentIntentId: "pi_gone", totalAmount: 5000, metadata: null },
    ] as never);
    stripeReconcile.mockResolvedValue({
      missingAtProvider: ["pi_gone"],
      missingLocally: [{ ref: "pi_unknown", amount: 999 }],
      amountMismatches: [],
    });
    m.reconciliationDifference.createMany.mockResolvedValue({ count: 2 } as never);
    m.reconciliationRun.update.mockResolvedValue({ id: "run-2", status: "COMPLETED", differences: [] } as never);

    await reconciliationService.runReconciliation("stripe", new Date("2026-01-01"), new Date("2026-01-15"));

    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ kind: "MISSING_AT_PROVIDER", businessRefType: "Checkout", businessRefId: "checkout-2", providerRef: "pi_gone", expectedAmount: 5000 }),
        expect.objectContaining({ kind: "MISSING_LOCALLY", providerRef: "pi_unknown", actualAmount: 999 }),
      ]),
    });
  });

  it("reliability scenario #1 (architecture doc §18) — a checkout whose webhook never arrives stays PENDING forever, so reconciliation is the only thing that ever surfaces the money Stripe actually captured", async () => {
    // The webhook never arrived: the checkout is still PENDING in our DB, so
    // gatherStripeLocalRecords (which only selects status: "SUCCEEDED")
    // never includes it — exactly what "lost webhook" looks like locally.
    m.reconciliationRun.create.mockResolvedValue({ id: "run-lost-webhook" } as never);
    m.checkout.findMany.mockResolvedValue([]); // nothing SUCCEEDED locally
    // But Stripe genuinely captured the payment — the provider's own
    // transaction list for the period includes it.
    stripeReconcile.mockResolvedValue({
      missingAtProvider: [],
      missingLocally: [{ ref: "pi_lost_webhook", amount: 4500 }],
      amountMismatches: [],
    });
    m.reconciliationDifference.createMany.mockResolvedValue({ count: 1 } as never);
    m.reconciliationRun.update.mockResolvedValue({ id: "run-lost-webhook", status: "COMPLETED", differences: [] } as never);

    const result = await reconciliationService.runReconciliation("stripe", new Date("2026-01-01"), new Date("2026-01-15"));

    // Real detection, not a fabricated clean run: the run completes (it
    // didn't crash), but it surfaces the real discrepancy for ops to act on.
    expect(m.reconciliationDifference.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          runId: "run-lost-webhook",
          kind: "MISSING_LOCALLY",
          providerRef: "pi_lost_webhook",
          actualAmount: 4500,
          businessRefType: "Unknown", // no local record exists to attribute it to — that IS the finding
        }),
      ],
    });
    expect(result).toBeDefined();
  });

  it("marks the run FAILED (and still rethrows) when the provider call itself throws — never silently swallows a real error", async () => {
    m.reconciliationRun.create.mockResolvedValue({ id: "run-3" } as never);
    stripeReconcile.mockRejectedValue(new Error("Stripe API unavailable"));
    m.reconciliationRun.update.mockResolvedValue({} as never);

    await expect(
      reconciliationService.runReconciliation("stripe", new Date("2026-01-01"), new Date("2026-01-15")),
    ).rejects.toThrow("Stripe API unavailable");

    expect(m.reconciliationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-3" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("Paystack reconciliation stays honestly unimplemented — never fabricates a clean run", async () => {
    m.reconciliationRun.create.mockResolvedValue({ id: "run-4" } as never);
    m.reconciliationRun.update.mockResolvedValue({} as never);

    await expect(
      reconciliationService.runReconciliation("paystack", new Date("2026-01-01"), new Date("2026-01-15")),
    ).rejects.toThrow(/not yet implemented/);
  });
});

describe("reconciliationService.resolveDifference", () => {
  it("is idempotent — resolving an already-resolved difference doesn't re-resolve it", async () => {
    m.reconciliationDifference.findUnique.mockResolvedValue({ id: "diff-1", status: "RESOLVED" } as never);
    const result = await reconciliationService.resolveDifference("diff-1", "already handled");
    expect(result).toEqual({ id: "diff-1", status: "RESOLVED" });
    expect(m.reconciliationDifference.update).not.toHaveBeenCalled();
  });

  it("resolves an open difference with the given note", async () => {
    m.reconciliationDifference.findUnique.mockResolvedValue({ id: "diff-2", status: "OPEN" } as never);
    m.reconciliationDifference.update.mockResolvedValue({ id: "diff-2", status: "RESOLVED" } as never);

    await reconciliationService.resolveDifference("diff-2", "confirmed duplicate webhook, no real discrepancy");

    expect(m.reconciliationDifference.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "diff-2" }, data: expect.objectContaining({ status: "RESOLVED", note: "confirmed duplicate webhook, no real discrepancy" }) }),
    );
  });
});

describe("reconciliationService.getBalances — real balances, computed from actual LedgerEntry rows only", () => {
  it("computes balance as sum(CREDIT) - sum(DEBIT), never a stored/cached number", async () => {
    m.ledgerAccount.findMany.mockResolvedValue([
      {
        id: "acct-1", type: "VENDOR_PAYABLE", currency: "GBP", ownerType: "VENDOR", ownerId: "vendor-1",
        entries: [
          { direction: "CREDIT", amount: 5000 },
          { direction: "DEBIT", amount: 1200 },
          { direction: "CREDIT", amount: 300 },
        ],
      },
    ] as never);

    const balances = await reconciliationService.getBalances();

    expect(balances).toEqual([
      expect.objectContaining({ id: "acct-1", type: "VENDOR_PAYABLE", currency: "GBP", entryCount: 3, balance: 4100 }),
    ]);
  });

  it("an account with no entries has a zero balance, not undefined/NaN", async () => {
    m.ledgerAccount.findMany.mockResolvedValue([
      { id: "acct-2", type: "PLATFORM_FEE_REVENUE", currency: "USD", ownerType: "PLATFORM", ownerId: null, entries: [] },
    ] as never);

    const balances = await reconciliationService.getBalances();
    expect(balances[0].balance).toBe(0);
  });
});
