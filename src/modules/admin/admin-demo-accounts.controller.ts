import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { adminDemoAccountsService } from "./admin-demo-accounts.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

export async function adminProvisionDemoAccount(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const targetUserId = requireIdParam(request);
  const reason = requireAuditReason(request.body?.reason, "demo provisioning reason");
  const creditMinor = request.body?.creditMinor !== undefined ? Number(request.body.creditMinor) : undefined;
  const currency = typeof request.body?.currency === "string" ? request.body.currency : undefined;

  const result = await adminDemoAccountsService.provision(targetUserId, { reason, creditMinor, currency });

  await recordAudit({
    request,
    actorId,
    action: "user.demo_provision",
    entityType: "User",
    entityId: targetUserId,
    reason,
    afterState: { isTest: result.isTest, walletBalanceMinor: result.walletBalanceMinor, currency: result.currency },
    failClosed: true,
  });

  response.status(200).json(result);
}

export async function adminCreateDemoAccount(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const reason = requireAuditReason(request.body?.reason, "demo account creation reason");

  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const name = typeof request.body?.name === "string" && request.body.name.trim() ? request.body.name.trim() : "Demo Account";
  if (!email || !email.includes("@")) throw new AppError("Valid email required", 400);
  if (!password || password.length < 8) throw new AppError("Password must be at least 8 characters", 400);

  const creditMinor = request.body?.creditMinor !== undefined ? Number(request.body.creditMinor) : undefined;
  const currency = typeof request.body?.currency === "string" ? request.body.currency : undefined;

  const result = await adminDemoAccountsService.createAndProvision({ email, password, name, reason, creditMinor, currency });

  await recordAudit({
    request,
    actorId,
    action: "user.demo_create",
    entityType: "User",
    entityId: result.userId,
    reason,
    afterState: { email: result.email, isTest: result.isTest, walletBalanceMinor: result.walletBalanceMinor, currency: result.currency },
    failClosed: true,
  });

  response.status(201).json(result);
}
