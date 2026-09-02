import { Router, type Request, type Response } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { verificationService } from "../verification/verification.service";
import { scheduledCommunicationService } from "../communications/scheduled-communication.service";
import { automationDetectors } from "../automation/automation.detectors";
import { renewalsService } from "../regular-deliveries/renewals.service";
import { communityCampaignsService } from "../community-buy/community-campaigns.service";
import { campaignContributionsService } from "../community-buy/campaign-contributions.service";

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
  return { ...generation, attempted: readyForPayment.length, charged, failed };
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
  };
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
