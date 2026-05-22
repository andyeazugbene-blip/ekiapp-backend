import type { Request, Response } from "express";

import { escrowHealthService } from "./escrow-health.service";

/**
 * GET /api/admin/escrow/health
 * Returns current escrow outstanding vs expected balance.
 */
export async function getEscrowHealth(_request: Request, response: Response): Promise<void> {
  const health = await escrowHealthService.getHealth();
  response.status(200).json(health);
}
