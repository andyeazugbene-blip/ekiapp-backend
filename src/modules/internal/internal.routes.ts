import { Router, type Request, type Response } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { verificationService } from "../verification/verification.service";
import { scheduledCommunicationService } from "../communications/scheduled-communication.service";
import { automationDetectors } from "../automation/automation.detectors";
import { renewalsService } from "../regular-deliveries/renewals.service";
import { communityCampaignsService } from "../community-buy/community-campaigns.service";
import { campaignContributionsService } from "../community-buy/campaign-contributions.service";
import { escrowService } from "../paystack/escrow.service";
import { escrowHealthService } from "../paystack/escrow-health.service";
import { reconciliationService } from "../ledger/reconciliation.service";
import { paymentAnomalyService } from "../ledger/payment-anomaly.service";
import { fulfilmentDelayService } from "../community-buy/fulfilment-delay.service";
import { sendEmail } from "../../lib/email";
import { emailTemplates } from "../../lib/email-templates";
import { enqueueEmail } from "../../lib/email-queue";

export const internalRouter = Router();

function requireCronSecret(req: Request, res: Response): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ error: "CRON_SECRET not configured" });
    return false;
  }
  // Vercel Cron (see vercel.json's "crons") calls via GET and automatically
  // sends `Authorization: Bearer $CRON_SECRET` — accept that alongside the
  // original custom header so either Vercel Cron or an external scheduler
  // (e.g. a GitHub Actions cron workflow) can trigger these jobs.
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (req.headers["x-job-secret"] !== secret && bearer !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── Individual jobs (return a plain result, never touch `res`) ───────────
// Kept separate from the HTTP handlers below so handleDailySweep can run
// all of them from one Vercel Cron entry — see the count-limit note there.

async function runVerificationProofCleanup() {
  return verificationService.cleanupVerificationProofs();
}

// Sends any admin-scheduled communications whose scheduledFor time has
// passed. Previously the only trigger was an admin manually clicking "Run
// Due Now" in the admin panel — "Schedule Later" silently did nothing
// unless someone remembered to come back and click that button.
async function runScheduledCommunications() {
  return scheduledCommunicationService.runDue();
}

// Runs the Automation Engine detectors that don't depend on Regular
// Deliveries or Community Buy data (those are wired in with those modules).
async function runAutomationSweep() {
  return automationDetectors.runSweep();
}

// Regular Deliveries: generates renewals due today, then attempts payment
// for every renewal already sitting at READY_FOR_PAYMENT (vendor already
// confirmed stock and any price change was already approved/auto-approved
// on an earlier sweep).
async function runRenewalsSweep() {
  const generation = await renewalsService.generateDueRenewals();
  const reminded = await renewalsService.sendUpcomingRenewalReminders();
  const priceApprovalExpiry = await renewalsService.expirePriceApprovalTimeouts();

  // Reliability scenario #6 "provider timeout" recovery — a renewal left
  // ambiguous by a connection/API error during attemptPayment() (see that
  // function's comment) gets a real requery here, safely replaying the
  // same idempotency key rather than sitting stuck forever.
  const ambiguous = await prisma.renewal.findMany({
    where: { status: "PAYMENT_PROCESSING", paymentAttempts: { some: { status: "PENDING", stripePaymentIntentId: null } } },
    select: { id: true },
    take: 200,
  });
  let requeried = 0;
  for (const renewal of ambiguous) {
    try {
      const outcome = await renewalsService.requeryAmbiguousAttempt(renewal.id);
      if (outcome.handled) requeried++;
    } catch (err) {
      logger.error("Renewal ambiguous-payment requery failed", { renewalId: renewal.id, error: String(err) });
    }
  }

  const readyForPayment = await prisma.renewal.findMany({
    where: { status: "READY_FOR_PAYMENT" },
    select: { id: true },
    take: 200,
  });
  let charged = 0;
  let failed = 0;
  for (const renewal of readyForPayment) {
    try {
      await renewalsService.attemptPayment(renewal.id);
      const outcome = await prisma.renewal.findUnique({ where: { id: renewal.id }, select: { status: true } });
      if (outcome?.status === "ORDER_CREATED") charged++;
      else failed++;
    } catch (err) {
      failed++;
      logger.error("Renewal payment attempt failed", { renewalId: renewal.id, error: String(err) });
    }
  }
  return { ...generation, reminded, priceApprovalExpiry, requeried, attempted: readyForPayment.length, charged, failed };
}

// Community Buy: closes campaigns whose deadline has passed (deciding
// success/failure from reconciled PAID totals, never a progress bar —
// spec §8.7/§22), reminds participants of approaching deadlines, and
// submits any pending refunds from a previously-failed campaign.
async function runCommunityBuySweep() {
  const closing = await communityCampaignsService.closeDueCampaigns();
  const rescueOutcome = await communityCampaignsService.evaluateRescueExpiry();
  const remindedParticipants = await communityCampaignsService.remindApproachingDeadlines();
  const refunds = await campaignContributionsService.processPendingRefunds();

  // Reliability scenario #6 "provider timeout" recovery — the Community
  // Buy equivalent of the renewals requery above.
  const ambiguous = await prisma.campaignContribution.findMany({
    where: { status: "PAYMENT_PROCESSING", chargeAttempts: { some: { status: "PENDING", stripePaymentIntentId: null } } },
    select: { id: true },
    take: 200,
  });
  let requeried = 0;
  for (const contribution of ambiguous) {
    try {
      const outcome = await campaignContributionsService.requeryAmbiguousCharge(contribution.id);
      if (outcome.handled) requeried++;
    } catch (err) {
      logger.error("Pledge ambiguous-charge requery failed", { contributionId: contribution.id, error: String(err) });
    }
  }

  return {
    closed: closing.closed,
    succeeded: closing.succeeded,
    campaignsFailed: closing.failed,
    rescueWindowsOpened: closing.rescued,
    rescueWindowsExpiredSucceeded: rescueOutcome.rescued,
    rescueWindowsExpiredFailed: rescueOutcome.failed,
    remindedParticipants,
    refundsProcessed: refunds.processed,
    refundsFailed: refunds.failed,
    ambiguousChargesRequeried: requeried,
  };
}

// Paystack domestic escrow: auto-cancel+refund orders where the vendor
// never confirmed within the timeout window, and auto-release payouts for
// dispatched orders past the buyer-confirmation window with no dispute.
//
// These previously only ran via BullMQ workers (src/workers/escrow-*.ts)
// started from startWorkers() in src/server.ts — which is NEVER invoked on
// Vercel (the deployed entrypoint is src/app.ts, per vercel.json). Real
// vendor money was sitting in escrow with no automatic release or timeout
// mechanism running in production at all. Folding the same service calls
// into this cron sweep is the smallest safe fix: 15-minute responsiveness
// becomes once-daily, which is still correct for 24h/48h windows and is
// infinitely better than never running.
async function runEscrowSweep() {
  const cancelled = await escrowService.processVendorTimeouts();
  const released = await escrowService.processAutoReleases();
  return { vendorTimeoutsCancelled: cancelled, autoReleased: released };
}

// Same dead-worker problem as runEscrowSweep — alerts ops when outstanding
// escrow balance exceeds a threshold. Alert-only, no money movement.
async function runEscrowBalanceCheck() {
  await escrowHealthService.checkAndAlert();
  return { checked: true };
}

// Restores stock + fails PENDING orders whose payment never completed
// within 30 minutes. Same dead-worker gap as the escrow jobs above — without
// this, abandoned checkouts permanently held decremented stock in production.
async function runCartCleanup() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const staleOrders = await prisma.order.findMany({
    where: { status: "PENDING", createdAt: { lt: cutoff }, payment: { status: "PENDING" } },
    include: { items: { select: { productId: true, quantity: true } }, payment: { select: { id: true } } },
  });
  let restored = 0;
  for (const order of staleOrders) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
        }
        await tx.order.update({ where: { id: order.id }, data: { status: "FAILED" } });
        if (order.payment) await tx.payment.update({ where: { id: order.payment.id }, data: { status: "FAILED" } });
      });
      restored++;
    } catch (err) {
      logger.error("Cart cleanup: failed to restore order", { orderId: order.id, error: String(err) });
    }
  }
  return { staleOrdersFound: staleOrders.length, ordersRestored: restored };
}

// Low-stock vendor email nudges — same dead-worker gap (src/workers/stock-alerts.worker.ts
// only ran under startWorkers(), never invoked on Vercel).
const LOW_STOCK_THRESHOLD = 5;
async function runStockAlerts() {
  const lowStockProducts = await prisma.product.findMany({
    where: { isActive: true, stock: { lte: LOW_STOCK_THRESHOLD } },
    select: {
      title: true,
      stock: true,
      vendorId: true,
      vendor: { select: { storeName: true, contactEmail: true, user: { select: { email: true } } } },
    },
  });
  const vendorMap = new Map<string, { storeName: string; email: string; products: { title: string; stock: number }[] }>();
  for (const product of lowStockProducts) {
    const email = product.vendor.contactEmail ?? product.vendor.user.email;
    const existing = vendorMap.get(product.vendorId);
    if (existing) existing.products.push({ title: product.title, stock: product.stock });
    else vendorMap.set(product.vendorId, { storeName: product.vendor.storeName, email, products: [{ title: product.title, stock: product.stock }] });
  }
  let sent = 0;
  for (const data of vendorMap.values()) {
    const template = emailTemplates.lowStockAlert({ storeName: data.storeName, products: data.products });
    if (await sendEmail({ to: data.email, subject: template.subject, html: template.html })) sent++;
  }
  return { vendorsNotified: sent, lowStockProducts: lowStockProducts.length };
}

// Daily Stripe reconciliation — the architecture doc requires this to run
// on a real schedule, not admin-triggered-only. Covers the previous full
// UTC day; ReconciliationRun/ReconciliationDifference already existed with
// zero automatic writer before this. Paystack is intentionally excluded —
// its provider adapter still throws PROVIDER_NOT_IMPLEMENTED for
// reconcileTransactions (Stripe is the sole launch provider).
async function runReconciliationSweep() {
  const periodEnd = new Date();
  periodEnd.setUTCHours(0, 0, 0, 0);
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

  const run = await reconciliationService.runReconciliation("stripe", periodStart, periodEnd);

  const openDifferences = run.differences?.filter((d) => d.status === "OPEN") ?? [];
  if (openDifferences.length > 0) {
    const opsAlertEmail = process.env.OPS_ALERT_EMAIL;
    if (opsAlertEmail) {
      await enqueueEmail({
        to: opsAlertEmail,
        subject: `⚠️ Reconciliation found ${openDifferences.length} difference(s) for ${periodStart.toISOString().slice(0, 10)}`,
        html: `
          <h2>Daily Stripe Reconciliation</h2>
          <p>Run ${run.id} for ${periodStart.toISOString()} – ${periodEnd.toISOString()} found ${openDifferences.length} unresolved difference(s).</p>
          <ul>
            ${openDifferences.map((d) => `<li>${d.kind} · ${d.businessRefType} ${d.businessRefId} · provider ref ${d.providerRef} · expected ${d.expectedAmount ?? "—"} · actual ${d.actualAmount ?? "—"}</li>`).join("")}
          </ul>
          <p>Review in Admin → Ledger Reconciliation.</p>
        `,
      });
    }
  }

  return { runId: run.id, status: run.status, totalChecked: run.totalChecked, differencesFound: run.differences?.length ?? 0 };
}

// Real-data-only duplicate-payment / financial-inconsistency scan
// (architecture doc §15.3 / §19 "Duplicate-payment risk").
async function runPaymentAnomalyScan() {
  return paymentAnomalyService.scan();
}

// Real-data-only supplier-fulfilment delay scan (architecture doc §15.3 /
// §19 "Supplier fulfilment delayed").
async function runFulfilmentDelayScan() {
  return fulfilmentDelayService.scan();
}

// ─── HTTP handlers ──────────────────────────────────────────────────────
// GET for Vercel Cron (which only issues GET requests); POST kept for any
// external/manual trigger using the original x-job-secret header.

function makeJobHandler(name: string, run: () => Promise<Record<string, unknown>>) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!requireCronSecret(req, res)) return;
    try {
      const result = await run();
      logger.info(`Cron: ${name} completed`, result);
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error(`Cron: ${name} failed`, { error: String(err) });
      res.status(500).json({ error: `${name} failed` });
    }
  };
}

const jobs: [string, string, () => Promise<Record<string, unknown>>][] = [
  ["verification-proof-cleanup", "verification proof cleanup", runVerificationProofCleanup],
  ["run-scheduled-communications", "scheduled communications run", runScheduledCommunications],
  ["automation-sweep", "automation sweep", runAutomationSweep],
  ["renewals-sweep", "renewals sweep", runRenewalsSweep],
  ["community-buy-sweep", "Community Buy sweep", runCommunityBuySweep],
  ["escrow-sweep", "escrow timeout/auto-release sweep", runEscrowSweep],
  ["escrow-balance-check", "escrow balance check", runEscrowBalanceCheck],
  ["cart-cleanup", "cart cleanup", runCartCleanup],
  ["stock-alerts", "low-stock vendor alerts", runStockAlerts],
  ["reconciliation-sweep", "daily Stripe reconciliation", runReconciliationSweep],
  ["payment-anomaly-scan", "duplicate-payment / financial-inconsistency scan", runPaymentAnomalyScan],
  ["fulfilment-delay-scan", "supplier-fulfilment delay scan", runFulfilmentDelayScan],
];

for (const [path, name, run] of jobs) {
  const handler = makeJobHandler(name, run);
  internalRouter.get(`/jobs/${path}`, handler);
  internalRouter.post(`/jobs/${path}`, handler);
}

// Single combined entry point for Vercel Cron itself. Vercel's Hobby plan
// caps the *number* of cron jobs in vercel.json (not just their frequency)
// — registering one job here that runs everything in sequence keeps this
// working regardless of the account's plan tier, while the routes above
// stay available individually for manual/targeted triggering or a future
// move to a paid plan with per-job schedules.
async function handleDailySweep(req: Request, res: Response): Promise<void> {
  if (!requireCronSecret(req, res)) return;
  const results: Record<string, unknown> = {};
  for (const [path, name, run] of jobs) {
    try {
      results[path] = await run();
    } catch (err) {
      logger.error(`Cron: ${name} failed (daily sweep)`, { error: String(err) });
      results[path] = { error: String(err) };
    }
  }
  logger.info("Cron: daily sweep completed", results);
  res.json({ ok: true, results });
}

internalRouter.get("/jobs/daily-sweep", handleDailySweep);
internalRouter.post("/jobs/daily-sweep", handleDailySweep);
