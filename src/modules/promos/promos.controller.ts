import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { promosService } from "./promos.service";
import {
  validateCreatePromoCodeInput,
  validateCreateVendorPromoCodeInput,
  validateUpdatePromoCodeInput,
  validateValidatePromoInput,
} from "./promos.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

// ─── Buyer ───────────────────────────────────────────────────────────────────

export async function validatePromo(request: Request, response: Response): Promise<void> {
  const input = validateValidatePromoInput(request.body);
  const result = await promosService.validatePromo(requireUserId(request), input);
  response.status(200).json(result);
}

export async function createVendorPromoCode(request: Request, response: Response): Promise<void> {
  const input = validateCreateVendorPromoCodeInput(request.body);
  const promoCode = await promosService.createVendorPromoCode(requireUserId(request), input);
  response.status(201).json({ promoCode });
}

export async function listVendorPromoCodes(request: Request, response: Response): Promise<void> {
  const promoCodes = await promosService.listVendorPromoCodes(requireUserId(request));
  response.status(200).json({ promoCodes });
}

export async function deleteVendorPromoCode(request: Request, response: Response): Promise<void> {
  await promosService.deleteVendorPromoCode(requireUserId(request), requireIdParam(request));
  response.status(200).json({ message: "Promo code deleted" });
}

// ─── Public ─────────────────────────────────────────────────────────────────

export async function listPublicDeals(_request: Request, response: Response): Promise<void> {
  const deals = await promosService.listPublicDeals();
  response.status(200).json(deals);
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export async function createPromoCode(request: Request, response: Response): Promise<void> {
  const reason = requireAuditReason((request.body as Record<string, unknown> | undefined)?.reason);
  const input = validateCreatePromoCodeInput(request.body);
  const promoCode = await promosService.createPromoCode(input);
  await recordAudit({
    actorId: requireUserId(request),
    action: "promo_code.create",
    entityType: "PromoCode",
    entityId: promoCode.id,
    afterState: { code: promoCode.code, type: promoCode.type, value: promoCode.value, maxUses: promoCode.maxUses, validUntil: promoCode.validUntil, vendorId: promoCode.vendorId },
    reason,
    request,
    failClosed: true,
  });
  response.status(201).json({ promoCode });
}

export async function listPromoCodes(_request: Request, response: Response): Promise<void> {
  const promoCodes = await promosService.listPromoCodes();
  response.status(200).json({ promoCodes });
}

export async function updatePromoCode(request: Request, response: Response): Promise<void> {
  const reason = requireAuditReason((request.body as Record<string, unknown> | undefined)?.reason);
  const input = validateUpdatePromoCodeInput(request.body);
  const promoId = requireIdParam(request);
  const before = await prisma.promoCode.findUnique({ where: { id: promoId } });
  const promoCode = await promosService.updatePromoCode(promoId, input);
  await recordAudit({
    actorId: requireUserId(request),
    action: "promo_code.update",
    entityType: "PromoCode",
    entityId: promoId,
    beforeState: before ? { code: before.code, isActive: before.isActive, maxUses: before.maxUses, validUntil: before.validUntil } : undefined,
    afterState: { code: promoCode.code, isActive: promoCode.isActive, maxUses: promoCode.maxUses, validUntil: promoCode.validUntil },
    reason,
    request,
    failClosed: true,
  });
  response.status(200).json({ promoCode });
}
