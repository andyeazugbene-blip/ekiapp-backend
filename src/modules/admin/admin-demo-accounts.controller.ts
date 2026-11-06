import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { adminDemoAccountsService } from "./admin-demo-accounts.service";
import { adminDemoShowcaseService } from "./admin-demo-showcase.service";

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

export async function adminFillDemoAccount(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const targetUserId = requireIdParam(request);
  const reason = requireAuditReason(request.body?.reason, "demo data reason");
  const result = await adminDemoShowcaseService.fillExisting(targetUserId, reason);
  await recordAudit({ request, actorId, action: "user.demo_fill", entityType: "User", entityId: targetUserId, reason, afterState: result, failClosed: true });
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
  const fullFeature = request.body?.fullFeature === true;
  const requestedStoreName = typeof request.body?.storeName === "string" && request.body.storeName.trim() ? request.body.storeName.trim() : undefined;
  const storeName = requestedStoreName ?? (fullFeature ? "Eki Demo Foods" : undefined);
  const country = typeof request.body?.country === "string" && request.body.country.trim() ? request.body.country.trim() : undefined;
  const supplier = request.body?.supplier === true || fullFeature;

  const result = await adminDemoAccountsService.createAndProvision({ email, password, name, reason, creditMinor, currency, storeName, country, supplier });
  const showcase = fullFeature && result.vendor && result.supplierAccount
    ? await adminDemoShowcaseService.seed(actorId, { userId: result.userId, vendorId: result.vendor.id, supplierAccountId: result.supplierAccount.id, country: country ?? "GB" }, reason)
    : null;

  await recordAudit({
    request,
    actorId,
    action: "user.demo_create",
    entityType: "User",
    entityId: result.userId,
    reason,
    afterState: {
      email: result.email, isTest: result.isTest, walletBalanceMinor: result.walletBalanceMinor, currency: result.currency,
      vendorId: result.vendor?.id ?? null, supplierAccountId: result.supplierAccount?.id ?? null,
      showcaseWarnings: showcase?.warnings ?? [],
    },
    failClosed: true,
  });

  response.status(201).json({ ...result, showcase });
}
