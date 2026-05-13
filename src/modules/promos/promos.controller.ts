import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { promosService } from "./promos.service";
import {
  validateCreatePromoCodeInput,
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

// ─── Admin ───────────────────────────────────────────────────────────────────

export async function createPromoCode(request: Request, response: Response): Promise<void> {
  const input = validateCreatePromoCodeInput(request.body);
  const promoCode = await promosService.createPromoCode(input);
  response.status(201).json({ promoCode });
}

export async function listPromoCodes(_request: Request, response: Response): Promise<void> {
  const promoCodes = await promosService.listPromoCodes();
  response.status(200).json({ promoCodes });
}

export async function updatePromoCode(request: Request, response: Response): Promise<void> {
  const input = validateUpdatePromoCodeInput(request.body);
  const promoCode = await promosService.updatePromoCode(requireIdParam(request), input);
  response.status(200).json({ promoCode });
}
