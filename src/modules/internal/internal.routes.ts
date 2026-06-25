import { Router, type Request, type Response } from "express";

import { logger } from "../../lib/logger";
import { verificationService } from "../verification/verification.service";

export const internalRouter = Router();

function requireCronSecret(req: Request, res: Response): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ error: "CRON_SECRET not configured" });
    return false;
  }
  if (req.headers["x-job-secret"] !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

internalRouter.post("/jobs/verification-proof-cleanup", async (req: Request, res: Response) => {
  if (!requireCronSecret(req, res)) return;

  try {
    const result = await verificationService.cleanupVerificationProofs();
    logger.info("Cron: verification proof cleanup completed", result);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Cron: verification proof cleanup failed", { error: String(err) });
    res.status(500).json({ error: "Cleanup failed" });
  }
});
