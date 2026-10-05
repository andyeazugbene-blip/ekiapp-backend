import { AppError } from "../../shared/errors/app-error";
import type { CreateGiftCardInput, PurchaseGiftCardInput, UpdateGiftCardInput } from "./gift-cards.types";

export function validateCreateGiftCardInput(body: Record<string, unknown>): CreateGiftCardInput {
  const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : undefined;
  if (!title) throw new AppError("title is required", 400);

  const priceAmount = typeof body.priceAmount === "number" && Number.isFinite(body.priceAmount) && body.priceAmount > 0
    ? body.priceAmount
    : typeof body.priceAmount === "string"
      ? parseInt(body.priceAmount, 10)
      : undefined;

  if (!priceAmount || priceAmount <= 0 || !Number.isInteger(priceAmount)) {
    throw new AppError("priceAmount must be a positive integer (in cents)", 400);
  }

  return {
    title,
    description: typeof body.description === "string" ? body.description.trim() || undefined : undefined,
    priceAmount,
    currency: typeof body.currency === "string" ? body.currency.trim().toUpperCase() : undefined,
    imageUrl: typeof body.imageUrl === "string" ? body.imageUrl.trim() || undefined : undefined,
    isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
  };
}

export function validateUpdateGiftCardInput(body: Record<string, unknown>): UpdateGiftCardInput {
  const input: UpdateGiftCardInput = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      throw new AppError("title must be a non-empty string", 400);
    }
    input.title = body.title.trim();
  }

  if (body.description !== undefined) {
    input.description = typeof body.description === "string" ? body.description.trim() : undefined;
  }

  if (body.priceAmount !== undefined) {
    const amount = typeof body.priceAmount === "number"
      ? body.priceAmount
      : typeof body.priceAmount === "string"
        ? parseInt(body.priceAmount, 10)
        : undefined;

    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      throw new AppError("priceAmount must be a positive integer (in cents)", 400);
    }
    input.priceAmount = amount;
  }

  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || body.currency.trim().length === 0) {
      throw new AppError("currency must be a non-empty string", 400);
    }
    input.currency = body.currency.trim().toUpperCase();
  }

  if (body.imageUrl !== undefined) {
    input.imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : undefined;
  }

  if (body.isActive !== undefined) {
    input.isActive = Boolean(body.isActive);
  }

  return input;
}

export function validatePurchaseGiftCardInput(body: Record<string, unknown>): PurchaseGiftCardInput {
  const giftCardId = typeof body.giftCardId === "string" && body.giftCardId.trim().length > 0
    ? body.giftCardId.trim()
    : undefined;
  if (!giftCardId) throw new AppError("giftCardId is required", 400);

  return {
    giftCardId,
    recipientEmail: validateRecipientEmail(typeof body.recipientEmail === "string" ? body.recipientEmail.trim() || undefined : undefined),
    recipientName: typeof body.recipientName === "string" ? body.recipientName.trim() || undefined : undefined,
    message: typeof body.message === "string" ? body.message.trim() || undefined : undefined,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateRecipientEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!EMAIL_RE.test(value) || value.length > 254) throw new AppError("recipientEmail is not a valid email address", 400);
  return value.toLowerCase();
}

export function validateRedeemGiftCardInput(body: Record<string, unknown>): { code: string; amount?: number } {
  if (!body || typeof body !== "object") throw new AppError("Invalid request body", 400);
  if (typeof body.code !== "string" || body.code.trim().length === 0 || body.code.length > 64) {
    throw new AppError("code is required", 400);
  }
  let amount: number | undefined;
  if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
    amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError("amount must be a positive integer (minor units)", 400);
  }
  return { code: body.code, amount };
}

export function parseAdminPurchasedQuery(query: Record<string, unknown>): { q?: string; status?: string; limit: number; cursor?: string } {
  let limit = 20;
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n <= 0 || n > 100) throw new AppError("Invalid limit (1-100)", 400);
    limit = n;
  }
  return {
    q: typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined,
    status: typeof query.status === "string" && query.status ? query.status.toUpperCase() : undefined,
    cursor: typeof query.cursor === "string" && query.cursor ? query.cursor : undefined,
    limit,
  };
}
