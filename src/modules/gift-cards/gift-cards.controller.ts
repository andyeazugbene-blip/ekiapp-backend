import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { giftCardsService } from "./gift-cards.service";
import {
  validateCreateGiftCardInput,
  validateUpdateGiftCardInput,
  validatePurchaseGiftCardInput,
} from "./gift-cards.validation";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export async function adminCreateGiftCard(request: Request, response: Response): Promise<void> {
  const input = validateCreateGiftCardInput(request.body);
  const card = await giftCardsService.create(input);
  response.status(201).json({ giftCard: card });
}

export async function adminListGiftCards(_request: Request, response: Response): Promise<void> {
  const cards = await giftCardsService.listAll();
  response.status(200).json({ giftCards: cards });
}

export async function adminUpdateGiftCard(request: Request, response: Response): Promise<void> {
  const input = validateUpdateGiftCardInput(request.body);
  const card = await giftCardsService.update(requireIdParam(request), input);
  response.status(200).json({ giftCard: card });
}

export async function adminDeleteGiftCard(request: Request, response: Response): Promise<void> {
  await giftCardsService.delete(requireIdParam(request));
  response.status(200).json({ message: "Gift card deleted" });
}

// ─── Buyer ──────────────────────────────────────────────────────────────────

export async function listActiveGiftCards(_request: Request, response: Response): Promise<void> {
  const cards = await giftCardsService.listActive();
  response.status(200).json({ giftCards: cards });
}

export async function purchaseGiftCard(request: Request, response: Response): Promise<void> {
  const input = validatePurchaseGiftCardInput(request.body);
  const result = await giftCardsService.purchase(requireUserId(request), input);
  response.status(201).json(result);
}

export async function listPurchasedGiftCards(request: Request, response: Response): Promise<void> {
  const cards = await giftCardsService.listPurchased(requireUserId(request));
  response.status(200).json({ giftCards: cards });
}
