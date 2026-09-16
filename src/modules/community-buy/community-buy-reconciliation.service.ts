import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { campaignPayoutService } from "./campaign-payout.service";

const MAX_PERIOD_DAYS = 31;

/**
 * M6 — reconciliation for Community Buy's Direct Charge money movements.
 *
 * This is deliberately a SEPARATE module from ledger/reconciliation.service.ts,
 * not an extension of it. That module's PaymentProvider.reconcileTransactions()
 * lists PaymentIntents at the PLATFORM level (stripe.paymentIntents.list with
 * no `stripeAccount` option) — structurally unable to see a Direct Charge
 * PaymentIntent, which lives entirely in the CONNECTED account's own object
 * space. Forcing that shared, cross-feature interface (also used by Paystack,
 * which has no equivalent of any of these three object types) to support a
 * retrieve-per-record, connected-account-scoped strategy would be a real
 * design change to code outside Community Buy's ownership — not a
 * Community-Buy-scoped fix. Instead, this module retrieves each record
 * individually, with the correct account context, and persists into the
 * SAME ReconciliationRun/ReconciliationDifference tables (zero new
 * migration — `provider` and `kind` are both free-form strings, and `kind`
 * already anticipates "STATUS_MISMATCH").
 *
 * Three distinct money-movement models are covered, each with its own
 * Stripe object type and account context:
 *   1. Captured holds (CommunityBuyPaymentAuthorisation) — a Direct Charge
 *      PaymentIntent, retrieved with {stripeAccount: connected account}.
 *   2. Legacy transfers (CampaignSupplierPayment, PLEDGE_THEN_CHARGE mode)
 *      — a platform-level Transfer, retrieved with NO stripeAccount header.
 *   3. Manual payouts (CommunityBuyPayout) — a connected-account Payout,
 *      retrieved with {stripeAccount: connected account}. This is also the
 *      backstop for the payout.paid/failed/canceled webhook depending on an
 *      external, unconfirmed Stripe Dashboard "send Connect events to this
 *      endpoint" setting (see stripe.service.ts's handleCommunityBuyPayoutEvent
 *      doc comment) — if that webhook never arrives, this is what still
 *      catches a payout that actually resolved at the provider.
 */
const PROVIDER_TAG = "stripe-community-buy";

interface DifferenceInput {
  businessRefType: string;
  businessRefId: string;
  providerRef: string | null;
  expectedAmount: number | null;
  actualAmount: number | null;
  kind: string;
  status?: "OPEN" | "RESOLVED";
  note?: string | null;
  resolvedAt?: Date | null;
}

function isStripeResourceMissing(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === "resource_missing";
}

async function reconcileCapturedHolds(periodStart: Date, periodEnd: Date, differences: DifferenceInput[]): Promise<number> {
  const holds = await prisma.communityBuyPaymentAuthorisation.findMany({
    where: { captureStatus: "CAPTURED", paymentIntentId: { not: null }, updatedAt: { gte: periodStart, lte: periodEnd } },
  });

  for (const hold of holds) {
    const expectedAmount = hold.authorisedAmount ?? hold.consentedChargeAmount;
    try {
      const pi = await stripe.paymentIntents.retrieve(hold.paymentIntentId!, { stripeAccount: hold.supplierConnectedAccountId });
      if (pi.status !== "succeeded") {
        differences.push({
          businessRefType: "CommunityBuyPaymentAuthorisation", businessRefId: hold.id, providerRef: hold.paymentIntentId,
          expectedAmount, actualAmount: null, kind: "STATUS_MISMATCH",
          note: `Local captureStatus=CAPTURED but provider PaymentIntent status="${pi.status}"`,
        });
        await campaignPayoutService.escalateToManualReview(hold.campaignId, "capture_status_mismatch");
        continue;
      }
      const actualAmount = pi.amount_received;
      if (expectedAmount != null && actualAmount !== expectedAmount) {
        differences.push({
          businessRefType: "CommunityBuyPaymentAuthorisation", businessRefId: hold.id, providerRef: hold.paymentIntentId,
          expectedAmount, actualAmount, kind: "AMOUNT_MISMATCH",
        });
        await campaignPayoutService.escalateToManualReview(hold.campaignId, "capture_amount_mismatch");
      }
    } catch (error) {
      if (isStripeResourceMissing(error)) {
        differences.push({
          businessRefType: "CommunityBuyPaymentAuthorisation", businessRefId: hold.id, providerRef: hold.paymentIntentId,
          expectedAmount, actualAmount: null, kind: "MISSING_AT_PROVIDER",
        });
        await campaignPayoutService.escalateToManualReview(hold.campaignId, "capture_missing_at_provider");
        continue;
      }
      logger.error("Community Buy reconciliation: capture retrieve failed", { holdId: hold.id, errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  return holds.length;
}

async function reconcileLegacyTransfers(periodStart: Date, periodEnd: Date, differences: DifferenceInput[]): Promise<number> {
  const payments = await prisma.campaignSupplierPayment.findMany({
    where: { status: "PAID", stripeTransferId: { not: null }, updatedAt: { gte: periodStart, lte: periodEnd } },
  });

  for (const payment of payments) {
    try {
      const transfer = await stripe.transfers.retrieve(payment.stripeTransferId!);
      const expected = payment.netAmount;
      if (expected != null && transfer.amount !== expected) {
        differences.push({
          businessRefType: "CampaignSupplierPayment", businessRefId: payment.id, providerRef: payment.stripeTransferId,
          expectedAmount: expected, actualAmount: transfer.amount, kind: "AMOUNT_MISMATCH",
          note: "Legacy PLEDGE_THEN_CHARGE transfer — flagged for admin review via the existing supplier-payment hold action; this module never mutates CampaignSupplierPayment.",
        });
      }
      if (transfer.reversed) {
        differences.push({
          businessRefType: "CampaignSupplierPayment", businessRefId: payment.id, providerRef: payment.stripeTransferId,
          expectedAmount: expected, actualAmount: transfer.amount, kind: "STATUS_MISMATCH",
          note: "Local status=PAID but the Stripe Transfer has since been reversed",
        });
      }
    } catch (error) {
      if (isStripeResourceMissing(error)) {
        differences.push({
          businessRefType: "CampaignSupplierPayment", businessRefId: payment.id, providerRef: payment.stripeTransferId,
          expectedAmount: payment.netAmount, actualAmount: null, kind: "MISSING_AT_PROVIDER",
        });
        continue;
      }
      logger.error("Community Buy reconciliation: transfer retrieve failed", { paymentId: payment.id, errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  return payments.length;
}

async function reconcilePayouts(periodStart: Date, periodEnd: Date, differences: DifferenceInput[]): Promise<number> {
  const payouts = await prisma.communityBuyPayout.findMany({
    where: { status: { in: ["IN_TRANSIT", "PAID"] }, providerPayoutId: { not: null }, updatedAt: { gte: periodStart, lte: periodEnd } },
  });

  for (const payout of payouts) {
    try {
      const stripePayout = await stripe.payouts.retrieve(payout.providerPayoutId!, { stripeAccount: payout.supplierConnectedAccountId });
      const amountMismatch = stripePayout.amount !== payout.netPayoutAmount;

      if (payout.status === "IN_TRANSIT" && (stripePayout.status === "paid" || stripePayout.status === "failed" || stripePayout.status === "canceled")) {
        // Provider has a definitive, confirmed outcome we simply never
        // received a webhook for (e.g. the Dashboard "send Connect events
        // to this endpoint" setting is unconfirmed — see this module's own
        // doc comment). This is NOT silently auto-correcting a discrepancy:
        // it is the exact same provider-confirmed evidence the webhook
        // itself would have supplied, applied through the SAME guarded,
        // idempotent function. Logged as an already-RESOLVED difference so
        // the audit trail shows reconciliation is what caught it.
        const eventType = stripePayout.status === "paid" ? "payout.paid" : stripePayout.status === "canceled" ? "payout.canceled" : "payout.failed";
        await campaignPayoutService.resolvePayoutWebhook(payout.providerPayoutId!, eventType, stripePayout);
        differences.push({
          businessRefType: "CommunityBuyPayout", businessRefId: payout.id, providerRef: payout.providerPayoutId,
          expectedAmount: payout.netPayoutAmount, actualAmount: stripePayout.amount,
          kind: "STATUS_MISMATCH", status: "RESOLVED", resolvedAt: new Date(),
          note: `Reconciliation caught a missed payout webhook — provider status "${stripePayout.status}" applied via resolvePayoutWebhook()`,
        });
      } else if (payout.status === "PAID" && stripePayout.status !== "paid") {
        // AT-36 — genuine contradiction: we believe this was paid, provider
        // now disagrees (e.g. a subsequent reversal). Never silently
        // correct — and never escalateToManualReview() here, which
        // deliberately refuses to touch an already-PAID payout: markReversed()
        // is the dedicated, narrow exception for exactly this case.
        differences.push({
          businessRefType: "CommunityBuyPayout", businessRefId: payout.id, providerRef: payout.providerPayoutId,
          expectedAmount: payout.netPayoutAmount, actualAmount: stripePayout.amount, kind: "STATUS_MISMATCH",
          note: `Local status=PAID but provider payout status="${stripePayout.status}"`,
        });
        await campaignPayoutService.markReversed(payout.campaignId, "payout_status_mismatch");
      } else if (amountMismatch) {
        differences.push({
          businessRefType: "CommunityBuyPayout", businessRefId: payout.id, providerRef: payout.providerPayoutId,
          expectedAmount: payout.netPayoutAmount, actualAmount: stripePayout.amount, kind: "AMOUNT_MISMATCH",
        });
        if (payout.status === "PAID") await campaignPayoutService.markReversed(payout.campaignId, "payout_amount_mismatch");
      }
    } catch (error) {
      if (isStripeResourceMissing(error)) {
        differences.push({
          businessRefType: "CommunityBuyPayout", businessRefId: payout.id, providerRef: payout.providerPayoutId,
          expectedAmount: payout.netPayoutAmount, actualAmount: null, kind: "MISSING_AT_PROVIDER",
        });
        if (payout.status === "PAID") {
          await campaignPayoutService.markReversed(payout.campaignId, "payout_missing_at_provider");
        } else {
          await campaignPayoutService.escalateToManualReview(payout.campaignId, "payout_missing_at_provider");
        }
        continue;
      }
      logger.error("Community Buy reconciliation: payout retrieve failed", { payoutId: payout.id, errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  return payouts.length;
}

export const communityBuyReconciliationService = {
  async runReconciliation(periodStart: Date, periodEnd: Date) {
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodEnd <= periodStart) {
      throw new AppError("periodStart must be a valid date before periodEnd", 400);
    }
    const days = (periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000);
    if (days > MAX_PERIOD_DAYS) {
      throw new AppError(`Reconciliation period cannot exceed ${MAX_PERIOD_DAYS} days`, 400);
    }

    const run = await prisma.reconciliationRun.create({ data: { provider: PROVIDER_TAG, periodStart, periodEnd, status: "RUNNING" } });

    try {
      const differences: DifferenceInput[] = [];
      const totalChecked =
        (await reconcileCapturedHolds(periodStart, periodEnd, differences)) +
        (await reconcileLegacyTransfers(periodStart, periodEnd, differences)) +
        (await reconcilePayouts(periodStart, periodEnd, differences));

      if (differences.length > 0) {
        await prisma.reconciliationDifference.createMany({
          data: differences.map((d) => ({
            businessRefType: d.businessRefType,
            businessRefId: d.businessRefId,
            providerRef: d.providerRef,
            expectedAmount: d.expectedAmount,
            actualAmount: d.actualAmount,
            kind: d.kind,
            status: d.status ?? "OPEN",
            note: d.note ?? null,
            resolvedAt: d.resolvedAt ?? null,
            runId: run.id,
          })),
        });
      }

      return prisma.reconciliationRun.update({
        where: { id: run.id },
        data: { status: "COMPLETED", completedAt: new Date(), totalChecked },
        include: { differences: true },
      });
    } catch (error) {
      logger.error("Community Buy reconciliation run failed", { runId: run.id, errorMessage: error instanceof Error ? error.message : String(error) });
      await prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date() } });
      throw error;
    }
  },
};

export type { DifferenceInput as CommunityBuyReconciliationDifferenceInput };
