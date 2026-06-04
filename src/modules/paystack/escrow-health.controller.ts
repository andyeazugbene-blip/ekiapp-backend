import type { Request, Response } from "express";

import { escrowHealthService } from "./escrow-health.service";
import { AppError } from "../../shared/errors/app-error";

/**
 * GET /api/admin/escrow/health
 * Returns current escrow outstanding vs expected balance.
 */
export async function getEscrowHealth(_request: Request, response: Response): Promise<void> {
  const health = await escrowHealthService.getHealth();
  response.status(200).json(health);
}

export async function updateEscrowProvider(request: Request, response: Response): Promise<void> {
  const id = typeof request.params.id === "string" ? request.params.id : "";
  if (!id) throw new AppError("Invalid escrow provider id", 400);
  const raw = (request.body ?? {}) as Record<string, unknown>;
  const protectionWindowHours =
    raw.protectionWindowHours === undefined ? undefined : Number(raw.protectionWindowHours);
  if (protectionWindowHours !== undefined && (!Number.isInteger(protectionWindowHours) || protectionWindowHours < 1 || protectionWindowHours > 336)) {
    throw new AppError("protectionWindowHours must be between 1 and 336", 400);
  }
  const otpChannel = typeof raw.otpChannel === "string" ? raw.otpChannel.toUpperCase() : undefined;
  if (otpChannel !== undefined && !["SMS", "EMAIL", "SMS_EMAIL"].includes(otpChannel)) {
    throw new AppError("Invalid otpChannel", 400);
  }
  const provider = await escrowHealthService.updateProviderConfig(id, {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    payoutSupported: typeof raw.payoutSupported === "boolean" ? raw.payoutSupported : undefined,
    otpChannel: otpChannel as "SMS" | "EMAIL" | "SMS_EMAIL" | undefined,
    protectionWindowHours,
    notes: typeof raw.notes === "string" ? raw.notes.trim() : raw.notes === null ? null : undefined,
  });
  response.status(200).json({ provider });
}
