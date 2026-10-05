import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { giftCardsService } from "./gift-cards.service";
import { notifyGiftCardStatusChange } from "./gift-cards.notify";
import {
  parseAdminPurchasedQuery,
  validateCreateGiftCardInput,
  validatePurchaseGiftCardInput,
  validateRedeemGiftCardInput,
  validateUpdateGiftCardInput,
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

// ─── Admin: catalogue ───────────────────────────────────────────────────────

export async function adminCreateGiftCard(request: Request, response: Response): Promise<void> {
  const input = validateCreateGiftCardInput(request.body);
  const card = await giftCardsService.create(input);
  await recordAudit({
    request,
    actorId: requireUserId(request),
    action: "giftcard.create",
    entityType: "GiftCard",
    entityId: card.id,
    reason: typeof request.body?.reason === "string" ? request.body.reason.trim() || undefined : undefined,
    afterState: card as unknown as Record<string, unknown>,
  });
  response.status(201).json({ giftCard: card });
}

export async function adminListGiftCards(request: Request, response: Response): Promise<void> {
  const cards = await giftCardsService.listAll({ includeArchived: request.query.includeArchived === "true" });
  response.status(200).json({ giftCards: cards });
}

export async function adminUpdateGiftCard(request: Request, response: Response): Promise<void> {
  const reason = requireAuditReason(request.body?.reason);
  const input = validateUpdateGiftCardInput(request.body);
  const { before, after } = await giftCardsService.update(requireIdParam(request), input);
  await recordAudit({
    request,
    actorId: requireUserId(request),
    action: "giftcard.update",
    entityType: "GiftCard",
    entityId: after.id,
    reason,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: after as unknown as Record<string, unknown>,
  });
  response.status(200).json({ giftCard: after });
}

function catalogueStateHandler(action: "pause" | "resume" | "archive") {
  return async (request: Request, response: Response): Promise<void> => {
    const reason = requireAuditReason(request.body?.reason);
    const { before, after } = await giftCardsService.setCatalogueState(requireIdParam(request), action);
    await recordAudit({
      request,
      actorId: requireUserId(request),
      action: `giftcard.${action}`,
      entityType: "GiftCard",
      entityId: after.id,
      reason,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: after as unknown as Record<string, unknown>,
    });
    response.status(200).json({ giftCard: after });
  };
}
export const adminPauseGiftCard = catalogueStateHandler("pause");
export const adminResumeGiftCard = catalogueStateHandler("resume");
export const adminArchiveGiftCard = catalogueStateHandler("archive");

// ─── Admin: purchased cards ─────────────────────────────────────────────────

export async function adminListPurchasedGiftCards(request: Request, response: Response): Promise<void> {
  const result = await giftCardsService.adminListPurchased(parseAdminPurchasedQuery(request.query as Record<string, unknown>));
  response.status(200).json(result);
}

export async function adminGetPurchasedGiftCard(request: Request, response: Response): Promise<void> {
  response.status(200).json({ purchasedGiftCard: await giftCardsService.adminGetPurchased(requireIdParam(request)) });
}

function purchasedStatusHandler(action: "cancel" | "pause" | "resume") {
  return async (request: Request, response: Response): Promise<void> => {
    const reason = requireAuditReason(request.body?.reason);
    const actorId = requireUserId(request);
    const id = requireIdParam(request);
    const { before, after, card } = await giftCardsService.adminChangePurchasedStatus(id, action, reason, actorId);
    await recordAudit({
      request,
      actorId,
      action: `purchased_giftcard.${action}`,
      entityType: "PurchasedGiftCard",
      entityId: id,
      reason,
      beforeState: before,
      afterState: after,
      metadata: { paymentReference: card.stripePaymentIntentId, amount: card.amount, currency: card.currency },
    });
    await notifyGiftCardStatusChange({
      buyerId: card.buyerId,
      purchasedGiftCardId: id,
      action: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "resumed",
      reason,
      amount: card.remainingBalance || card.amount,
      currency: card.currency,
    });
    response.status(200).json({ purchasedGiftCard: await giftCardsService.adminGetPurchased(id) });
  };
}
export const adminCancelPurchasedGiftCard = purchasedStatusHandler("cancel");
export const adminPausePurchasedGiftCard = purchasedStatusHandler("pause");
export const adminResumePurchasedGiftCard = purchasedStatusHandler("resume");

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

export async function redeemGiftCard(request: Request, response: Response): Promise<void> {
  const input = validateRedeemGiftCardInput(request.body);
  const result = await giftCardsService.redeem(requireUserId(request), input);
  response.status(200).json({ redemption: result });
}
