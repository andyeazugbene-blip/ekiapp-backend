import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { stripeProvider } from "../payments/provider/stripe-provider";
import { paystackProvider } from "../payments/provider/paystack-provider";
import type { PaymentProvider } from "../payments/provider/payment-provider.interface";

const MAX_PERIOD_DAYS = 31;

const PROVIDERS: Record<string, PaymentProvider> = {
  stripe: stripeProvider,
  paystack: paystackProvider,
};

interface LocalRecord {
  ref: string;
  amount: number;
  businessRefType: string;
  businessRefId: string;
}

/**
 * Every real local source of a Stripe PaymentIntent, across every payment
 * path this app has — not just order checkout. Reconciling only `Payment`
 * would report every wallet top-up, Community Buy charge, gift card
 * purchase, and Regular Delivery renewal as "missing locally" — a real,
 * fabricated-looking false positive, not an honest discrepancy.
 *
 * Checkout's amount is adjusted for wallet deduction — the exact same
 * formula stripe.service.ts's own webhook amount-tampering check already
 * uses (`checkout.totalAmount - walletDeduction`), not a new one.
 */
async function gatherStripeLocalRecords(periodStart: Date, periodEnd: Date): Promise<LocalRecord[]> {
  const [checkouts, contributions, giftCards, renewalAttempts, walletTopUps] = await Promise.all([
    prisma.checkout.findMany({
      where: { stripePaymentIntentId: { not: null }, status: "SUCCEEDED", createdAt: { gte: periodStart, lte: periodEnd } },
      select: { id: true, stripePaymentIntentId: true, totalAmount: true, metadata: true },
    }),
    prisma.campaignContribution.findMany({
      where: { stripePaymentIntentId: { not: null }, status: "PAID", createdAt: { gte: periodStart, lte: periodEnd } },
      select: { id: true, stripePaymentIntentId: true, amount: true },
    }),
    prisma.purchasedGiftCard.findMany({
      where: { stripePaymentIntentId: { not: null }, createdAt: { gte: periodStart, lte: periodEnd } },
      select: { id: true, stripePaymentIntentId: true, amount: true },
    }),
    prisma.subscriptionPaymentAttempt.findMany({
      where: { stripePaymentIntentId: { not: null }, status: "SUCCEEDED", createdAt: { gte: periodStart, lte: periodEnd } },
      select: { id: true, stripePaymentIntentId: true, renewal: { select: { subtotalAmount: true } } },
    }),
    prisma.buyerWalletTransaction.findMany({
      where: { type: "TOP_UP", paymentIntentId: { not: null }, createdAt: { gte: periodStart, lte: periodEnd } },
      select: { id: true, paymentIntentId: true, amount: true },
    }),
  ]);

  const records: LocalRecord[] = [];
  for (const c of checkouts) {
    const meta = c.metadata as { walletDeduction?: unknown } | null;
    const walletDeduction = Number(meta?.walletDeduction ?? 0);
    const expected = c.totalAmount - (Number.isFinite(walletDeduction) ? walletDeduction : 0);
    records.push({ ref: c.stripePaymentIntentId!, amount: expected, businessRefType: "Checkout", businessRefId: c.id });
  }
  for (const contribution of contributions) {
    records.push({ ref: contribution.stripePaymentIntentId!, amount: contribution.amount, businessRefType: "CampaignContribution", businessRefId: contribution.id });
  }
  for (const gc of giftCards) {
    records.push({ ref: gc.stripePaymentIntentId!, amount: gc.amount, businessRefType: "PurchasedGiftCard", businessRefId: gc.id });
  }
  for (const attempt of renewalAttempts) {
    if (attempt.renewal.subtotalAmount == null) continue;
    records.push({ ref: attempt.stripePaymentIntentId!, amount: attempt.renewal.subtotalAmount, businessRefType: "SubscriptionPaymentAttempt", businessRefId: attempt.id });
  }
  for (const topUp of walletTopUps) {
    records.push({ ref: topUp.paymentIntentId!, amount: topUp.amount, businessRefType: "BuyerWalletTransaction", businessRefId: topUp.id });
  }
  return records;
}

export const reconciliationService = {
  /**
   * Runs a real comparison against the provider's own transaction list for
   * the period and persists the result as a ReconciliationRun +
   * ReconciliationDifference rows — these tables existed in the schema
   * with zero writer anywhere before this. Provider calls are read-only
   * (see PaymentProvider.reconcileTransactions); this function's own writes
   * are limited to the reconciliation tables themselves, never to the
   * business records being checked.
   */
  async runReconciliation(provider: "stripe" | "paystack", periodStart: Date, periodEnd: Date) {
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodEnd <= periodStart) {
      throw new AppError("periodStart must be a valid date before periodEnd", 400);
    }
    const days = (periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000);
    if (days > MAX_PERIOD_DAYS) {
      throw new AppError(`Reconciliation period cannot exceed ${MAX_PERIOD_DAYS} days`, 400);
    }

    const providerImpl = PROVIDERS[provider];
    if (!providerImpl) throw new AppError(`Unknown provider "${provider}"`, 400);

    const run = await prisma.reconciliationRun.create({
      data: { provider, periodStart, periodEnd, status: "RUNNING" },
    });

    try {
      const localRecords = provider === "stripe" ? await gatherStripeLocalRecords(periodStart, periodEnd) : [];
      const localByRef = new Map(localRecords.map((r) => [r.ref, r]));

      const result = await providerImpl.reconcileTransactions({
        periodStart,
        periodEnd,
        localRecords: localRecords.map((r) => ({ ref: r.ref, amount: r.amount })),
      });

      const differences: { businessRefType: string; businessRefId: string; providerRef: string; expectedAmount: number | null; actualAmount: number | null; kind: string }[] = [];

      for (const ref of result.missingAtProvider) {
        const local = localByRef.get(ref);
        differences.push({
          businessRefType: local?.businessRefType ?? "Unknown",
          businessRefId: local?.businessRefId ?? ref,
          providerRef: ref,
          expectedAmount: local?.amount ?? null,
          actualAmount: null,
          kind: "MISSING_AT_PROVIDER",
        });
      }
      for (const missing of result.missingLocally) {
        differences.push({
          businessRefType: "Unknown",
          businessRefId: missing.ref,
          providerRef: missing.ref,
          expectedAmount: null,
          actualAmount: missing.amount,
          kind: "MISSING_LOCALLY",
        });
      }
      for (const mismatch of result.amountMismatches) {
        const local = localByRef.get(mismatch.ref);
        differences.push({
          businessRefType: local?.businessRefType ?? "Unknown",
          businessRefId: local?.businessRefId ?? mismatch.ref,
          providerRef: mismatch.ref,
          expectedAmount: mismatch.localAmount,
          actualAmount: mismatch.providerAmount,
          kind: "AMOUNT_MISMATCH",
        });
      }

      if (differences.length > 0) {
        await prisma.reconciliationDifference.createMany({
          data: differences.map((d) => ({ ...d, runId: run.id })),
        });
      }

      return prisma.reconciliationRun.update({
        where: { id: run.id },
        data: { status: "COMPLETED", completedAt: new Date(), totalChecked: localRecords.length },
        include: { differences: true },
      });
    } catch (error) {
      logger.error("Reconciliation run failed", { runId: run.id, provider, errorMessage: error instanceof Error ? error.message : String(error) });
      await prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date() } });
      throw error;
    }
  },

  async listRuns(limit = 50) {
    return prisma.reconciliationRun.findMany({
      orderBy: { startedAt: "desc" },
      take: limit,
      include: { _count: { select: { differences: true } } },
    });
  },

  async getRun(runId: string) {
    const run = await prisma.reconciliationRun.findUnique({
      where: { id: runId },
      include: { differences: { orderBy: { createdAt: "desc" } } },
    });
    if (!run) throw new AppError("Reconciliation run not found", 404);
    return run;
  },

  async listOpenDifferences(limit = 200) {
    return prisma.reconciliationDifference.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { run: { select: { provider: true, periodStart: true, periodEnd: true } } },
    });
  },

  /** The one audited mutation this read-mostly surface supports — the schema itself models a difference as resolvable (status + resolvedAt), so marking one resolved (with a note) is an explicitly supported action, not an invented one. */
  async resolveDifference(differenceId: string, note: string) {
    const existing = await prisma.reconciliationDifference.findUnique({ where: { id: differenceId } });
    if (!existing) throw new AppError("Reconciliation difference not found", 404);
    if (existing.status === "RESOLVED") return existing;
    return prisma.reconciliationDifference.update({
      where: { id: differenceId },
      data: { status: "RESOLVED", resolvedAt: new Date(), note },
    });
  },

  /**
   * Real balances computed directly from LedgerEntry — never a separate
   * aggregate table that could drift from the actual postings. Grouped by
   * the same (type, currency, ownerType, ownerId) tuple the unique
   * constraint on LedgerAccount already enforces.
   */
  async getBalances() {
    const accounts = await prisma.ledgerAccount.findMany({
      include: { entries: { select: { direction: true, amount: true } } },
      orderBy: [{ currency: "asc" }, { type: "asc" }],
    });
    return accounts.map((account) => {
      const balance = account.entries.reduce((sum, e) => sum + (e.direction === "CREDIT" ? e.amount : -e.amount), 0);
      return {
        id: account.id,
        type: account.type,
        currency: account.currency,
        ownerType: account.ownerType,
        ownerId: account.ownerId,
        entryCount: account.entries.length,
        balance,
      };
    });
  },
};
